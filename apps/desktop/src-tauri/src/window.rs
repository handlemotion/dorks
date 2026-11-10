//! Window chrome glue: the transparent window with its native material, the traffic-light buttons, and the two modes
//! (`onboarding`, `app`). The decisions (geometry, which material, frame sanity) are in `dorks_shell_core::window`.
//!
//! Everything here that touches AppKit must run on the main thread: `show_main` does, and `set_window_mode` is a plain
//! (non-async) command, which Tauri runs on the main thread.

use std::sync::atomic::Ordering;
use std::time::Duration;

use dorks_shell_core::window::{centered, choose_effect, ChromeInfo, Effect, Rect, WindowFrame, WindowMode, WindowTheme, TRAFFIC_LIGHTS_POSITION};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use crate::boot;
use crate::state::AppState;

/// `glass`, `vibrancy` or `none`: caps the window material (debugging, or for someone who dislikes transparency). It can
/// lower the effect but never ask for one the OS cannot draw.
pub const ENV_WINDOW_EFFECT: &str = "DORKS_WINDOW_EFFECT";
pub const EVENT_CHROME: &str = "dorks://window-chrome";
/// A burst of move/resize events is written to disk once, this long after the last one.
const FRAME_SAVE_DELAY: Duration = Duration::from_millis(600);

/// The material this machine can draw, after the `DORKS_WINDOW_EFFECT` cap.
pub fn detect_effect() -> Effect {
    choose_effect(cfg!(target_os = "macos"), native::glass_available(), std::env::var(ENV_WINDOW_EFFECT).ok().as_deref())
}

pub fn traffic_light_position() -> LogicalPosition<f64> {
    LogicalPosition::new(TRAFFIC_LIGHTS_POSITION.0, TRAFFIC_LIGHTS_POSITION.1)
}

/// Finishes a freshly built (still hidden) main window: material, mode geometry, then shows it. Main thread.
pub fn finish(app: &AppHandle, window: &WebviewWindow, mode: WindowMode, theme: WindowTheme, wanted: Effect) {
    let actual = native::apply_effect(window, wanted);
    // Re-assert after the material is attached: no window shadow, ever.
    let _ = window.set_shadow(false);
    let state = app.state::<AppState>();
    *state.chrome.lock().unwrap() = ChromeInfo::new(mode.spec(), actual, theme);
    apply_mode(app, window, mode);
    let _ = window.show();
    if !verification_mode() {
        let _ = window.set_focus();
    }
    log_state(window, "opened");
    if actual != wanted {
        // The page's init script was written for the effect we hoped for; tell it what is really behind it.
        boot::publish_config(app);
    }
}

/// Switches the window to `mode`: size, resizability, centring or the remembered frame, and the traffic lights. Main thread.
pub fn apply_mode(app: &AppHandle, window: &WebviewWindow, mode: WindowMode) {
    let spec = mode.spec();
    let logical = |(w, h): (f64, f64)| LogicalSize::new(w, h);
    if spec.resizable {
        let _ = window.set_max_size(None::<LogicalSize<f64>>);
        let _ = window.set_min_size(Some(logical(spec.min_size)));
        let _ = window.set_resizable(true);
        let _ = window.set_maximizable(true);
        let frame = app.state::<AppState>().settings.lock().unwrap().window_frame;
        match frame.and_then(|f| f.restorable(spec.min_size, &screens(app))) {
            Some(f) => {
                let _ = window.set_size(LogicalSize::new(f.width as f64, f.height as f64));
                let _ = window.set_position(LogicalPosition::new(f.x as f64, f.y as f64));
            }
            None => {
                let _ = window.set_size(logical(spec.size));
                center(window, spec.size);
            }
        }
    } else {
        // Fixed: the min/max pair is what stops a programmatic or keyboard resize; `resizable` removes the grab handles.
        let _ = window.set_min_size(Some(logical(spec.size)));
        let _ = window.set_max_size(Some(logical(spec.size)));
        let _ = window.set_resizable(false);
        let _ = window.set_maximizable(false);
        let _ = window.set_size(logical(spec.size));
        center(window, spec.size);
    }
    native::set_traffic_lights_hidden(window, !spec.traffic_lights);
    if verification_mode() {
        park(window);
    }
}

/// `DORKS_WINDOW_NOFOCUS=1`: for automated checks only. The app runs without a Dock icon, the window never takes focus, sits
/// below every other window and is parked so that all but a corner of it is off the screen, so a verification run does not
/// cover or interrupt the person using the Mac. The window still exists and can be captured with `screencapture -l <id>`.
pub const ENV_NOFOCUS: &str = "DORKS_WINDOW_NOFOCUS";

pub fn verification_mode() -> bool {
    std::env::var(ENV_NOFOCUS).is_ok_and(|v| !matches!(v.trim(), "" | "0" | "false"))
}

/// Moves the window to the bottom-right corner of its screen, leaving a 40 pt sliver visible (AppKit will not keep a titled
/// window fully off-screen), and keeps it below everything else.
fn park(window: &WebviewWindow) {
    let _ = window.set_always_on_bottom(true);
    let Some(monitor) = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten()) else { return };
    let scale = monitor.scale_factor();
    let (pos, size) = (monitor.position().to_logical::<f64>(scale), monitor.size().to_logical::<f64>(scale));
    let _ = window.set_position(LogicalPosition::new(pos.x + size.width - 40.0, pos.y + size.height - 40.0));
}

/// One line saying what the window looks like to AppKit, so the chrome can be checked from the log without looking at it.
pub fn log_state(window: &WebviewWindow, why: &str) {
    eprintln!("dorks: window {why}: {}", native::describe(window));
}

/// Centres `size` (logical) in the usable area (menu bar and Dock excluded) of the screen the window is on. Tauri's own
/// `center()` reads the window's current size, which still is the old one right after `set_size`, so it would centre the
/// wrong rectangle.
fn center(window: &WebviewWindow, size: (f64, f64)) {
    let Some(monitor) = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten()) else {
        let _ = window.center();
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (pos, dim) = (area.position.to_logical::<f64>(scale), area.size.to_logical::<f64>(scale));
    let rect = Rect { x: pos.x.round() as i32, y: pos.y.round() as i32, width: dim.width.round() as u32, height: dim.height.round() as u32 };
    let (x, y) = centered(size, rect);
    let _ = window.set_position(LogicalPosition::new(x as f64, y as f64));
}

/// `Some` for an explicit appearance, `None` to follow macOS.
pub fn tauri_theme(theme: WindowTheme) -> Option<tauri::Theme> {
    match theme {
        WindowTheme::Light => Some(tauri::Theme::Light),
        WindowTheme::Dark => Some(tauri::Theme::Dark),
        WindowTheme::System => None,
    }
}

/// The `set_window_theme` command: the window takes the app's appearance, which is what the native material (glass or
/// vibrancy) and the page's `prefers-color-scheme` follow. Remembered for the next launch. Main thread.
pub fn set_theme(app: &AppHandle, theme: WindowTheme) -> Result<ChromeInfo, String> {
    let state = app.state::<AppState>();
    state.settings.lock().unwrap().window_theme = theme;
    let chrome = {
        let mut chrome = state.chrome.lock().unwrap();
        chrome.theme = theme;
        chrome.clone()
    };
    if let Some(window) = app.get_webview_window("main") {
        window.set_theme(tauri_theme(theme)).map_err(|e| format!("cannot change the window theme: {e}"))?;
        log_state(&window, &format!("theme {theme}"));
    }
    flush(app);
    boot::publish_config(app);
    let _ = app.emit(EVENT_CHROME, &chrome);
    Ok(chrome)
}

/// Called for the `Focused` event: AppKit can bring hidden buttons back (full screen, theme changes), so re-assert the mode.
pub fn reassert(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let mode = app.state::<AppState>().chrome.lock().unwrap().mode;
    native::set_traffic_lights_hidden(&window, !mode.spec().traffic_lights);
}

/// The `set_window_mode` command: remembers the mode (so the next launch opens in it), re-chromes the window, and tells the
/// page (the `data-window-*` attributes and CSS variables, and the `dorks://window-chrome` event). Main thread.
pub fn set_mode(app: &AppHandle, mode: WindowMode) -> Result<ChromeInfo, String> {
    let state = app.state::<AppState>();
    let changed = {
        let mut settings = state.settings.lock().unwrap();
        let changed = settings.window_mode != mode;
        settings.window_mode = mode;
        changed
    };
    let chrome = {
        let mut chrome = state.chrome.lock().unwrap();
        let unchanged = chrome.mode == mode;
        *chrome = ChromeInfo::new(mode.spec(), chrome.effect, chrome.theme);
        if unchanged && !changed {
            return Ok(chrome.clone());
        }
        chrome.clone()
    };
    if let Some(window) = app.get_webview_window("main") {
        apply_mode(app, &window, mode);
        log_state(&window, &format!("mode {mode}"));
    }
    flush(app);
    boot::publish_config(app);
    let _ = app.emit(EVENT_CHROME, &chrome);
    Ok(chrome)
}

/// Remembers the app-mode frame (debounced). Ignored in onboarding, minimised and full screen.
pub fn remember_frame(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.chrome.lock().unwrap().mode != WindowMode::App {
        return;
    }
    let Some(window) = app.get_webview_window("main") else { return };
    if window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let (Ok(scale), Ok(pos), Ok(size)) = (window.scale_factor(), window.outer_position(), window.inner_size()) else { return };
    let (pos, size) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
    let frame = WindowFrame { x: pos.x.round() as i32, y: pos.y.round() as i32, width: size.width.round() as u32, height: size.height.round() as u32 };
    {
        let mut settings = state.settings.lock().unwrap();
        if settings.window_frame == Some(frame) {
            return;
        }
        settings.window_frame = Some(frame);
    }
    let generation = state.frame_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FRAME_SAVE_DELAY).await;
        if app.state::<AppState>().frame_gen.load(Ordering::SeqCst) == generation {
            flush(&app);
        }
    });
}

/// Writes the settings (mode and frame included) to disk now.
pub fn flush(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    if let Err(e) = settings.save(&state.paths.settings_file()) {
        eprintln!("dorks: cannot save settings: {e}");
    }
}

fn screens(app: &AppHandle) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let scale = m.scale_factor();
            let (pos, size) = (m.position().to_logical::<f64>(scale), m.size().to_logical::<f64>(scale));
            Rect { x: pos.x.round() as i32, y: pos.y.round() as i32, width: size.width.round() as u32, height: size.height.round() as u32 }
        })
        .collect()
}

#[cfg(target_os = "macos")]
mod native {
    use dorks_shell_core::window::Effect;
    use objc2_app_kit::{NSAppKitVersionNumber, NSAppearanceCustomization, NSWindow, NSWindowButton};
    use tauri::WebviewWindow;
    use window_vibrancy::{apply_liquid_glass, apply_vibrancy, LiquidGlassOptions, NSGlassEffectViewStyle, NSVisualEffectMaterial, NSVisualEffectState};

    /// `NSAppKitVersionNumber` of macOS 26.0, the first with `NSGlassEffectView` (the same bound window-vibrancy checks).
    const APPKIT_MACOS_26: f64 = 2685.0;

    pub fn glass_available() -> bool {
        // SAFETY: a read-only AppKit constant.
        unsafe { NSAppKitVersionNumber >= APPKIT_MACOS_26 }
    }

    /// Puts `wanted` behind the webview; returns what actually got applied (glass falls back to vibrancy, vibrancy to none).
    pub fn apply_effect(window: &WebviewWindow, wanted: Effect) -> Effect {
        if wanted == Effect::LiquidGlass {
            match apply_liquid_glass(window, LiquidGlassOptions::new(NSGlassEffectViewStyle::Regular)) {
                Ok(()) => return Effect::LiquidGlass,
                Err(e) => eprintln!("dorks: liquid glass unavailable ({e}); using vibrancy"),
            }
        }
        if wanted != Effect::None {
            // Active, so the material stays translucent when the window is not key (the default greys it out).
            match apply_vibrancy(window, NSVisualEffectMaterial::Sidebar, Some(NSVisualEffectState::Active), None) {
                Ok(()) => return Effect::Vibrancy,
                Err(e) => eprintln!("dorks: vibrancy unavailable ({e}); using an opaque window"),
            }
        }
        Effect::None
    }

    /// What AppKit has for the window right now, for the log: shadow, opacity, whether the three buttons are hidden, the
    /// resolved appearance, and the frame in points.
    pub fn describe(window: &WebviewWindow) -> String {
        let Ok(ptr) = window.ns_window() else { return "no NSWindow".into() };
        if ptr.is_null() {
            return "no NSWindow".into();
        }
        // SAFETY: as in `set_traffic_lights_hidden`.
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let hidden = |kind| ns_window.standardWindowButton(kind).map(|b| b.isHidden());
        let frame = ns_window.frame();
        format!(
            "shadow={} opaque={} buttons_hidden={:?}/{:?}/{:?} appearance={} frame={:.0}x{:.0}@{:.0},{:.0}",
            ns_window.hasShadow(),
            ns_window.isOpaque(),
            hidden(NSWindowButton::CloseButton),
            hidden(NSWindowButton::MiniaturizeButton),
            hidden(NSWindowButton::ZoomButton),
            ns_window.effectiveAppearance().name(),
            frame.size.width,
            frame.size.height,
            frame.origin.x,
            frame.origin.y,
        )
    }

    pub fn set_traffic_lights_hidden(window: &WebviewWindow, hidden: bool) {
        let Ok(ptr) = window.ns_window() else { return };
        if ptr.is_null() {
            return;
        }
        // SAFETY: Tauri hands out the live NSWindow of this window; we only message it on the main thread.
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        for kind in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
            if let Some(button) = ns_window.standardWindowButton(kind) {
                button.setHidden(hidden);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use dorks_shell_core::window::Effect;
    use tauri::WebviewWindow;

    pub fn glass_available() -> bool {
        false
    }
    pub fn apply_effect(_: &WebviewWindow, _: Effect) -> Effect {
        Effect::None
    }
    pub fn set_traffic_lights_hidden(_: &WebviewWindow, _: bool) {}
    pub fn describe(_: &WebviewWindow) -> String {
        "n/a".into()
    }
}
