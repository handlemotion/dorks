//! Window chrome, platform independent: the two window modes, the geometry each one wants, which background material to use,
//! and the sanity checks for a remembered window frame. The Tauri/AppKit glue lives in the parent crate (`src/window.rs`).

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// What the window is showing. The web app decides (via the `set_window_mode` command) and the shell remembers the last one,
/// so the next launch opens the right chrome before the page has loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    /// First-run setup: no traffic lights, fixed size, centred.
    #[default]
    Onboarding,
    /// The real app: traffic lights over the content, resizable, remembers its frame.
    App,
}

impl WindowMode {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowMode::Onboarding => "onboarding",
            WindowMode::App => "app",
        }
    }

    /// Geometry and chrome for this mode (logical points).
    pub fn spec(self) -> ChromeSpec {
        match self {
            WindowMode::Onboarding => ChromeSpec {
                mode: self,
                traffic_lights: false,
                resizable: false,
                size: (920.0, 680.0),
                min_size: (920.0, 680.0),
                titlebar_inset_left: 0.0,
                titlebar_height: 0.0,
            },
            WindowMode::App => ChromeSpec {
                mode: self,
                traffic_lights: true,
                resizable: true,
                size: (1200.0, 800.0),
                min_size: (900.0, 600.0),
                titlebar_inset_left: TRAFFIC_LIGHTS_INSET_LEFT,
                titlebar_height: TITLEBAR_HEIGHT,
            },
        }
    }
}

impl fmt::Display for WindowMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for WindowMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "onboarding" => Ok(WindowMode::Onboarding),
            "app" => Ok(WindowMode::App),
            other => Err(format!("unknown window mode {other:?}; use \"onboarding\" or \"app\"")),
        }
    }
}

/// Which appearance the window (and with it the native material behind the page, and the page's `prefers-color-scheme`)
/// uses. The web app has its own theme switch; it reports the active theme here so a light app never sits on a dark dim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WindowTheme {
    Light,
    Dark,
    /// Follow macOS (the default until the app says otherwise).
    #[default]
    System,
}

impl WindowTheme {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowTheme::Light => "light",
            WindowTheme::Dark => "dark",
            WindowTheme::System => "system",
        }
    }
}

impl fmt::Display for WindowTheme {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for WindowTheme {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "light" => Ok(WindowTheme::Light),
            "dark" => Ok(WindowTheme::Dark),
            "system" => Ok(WindowTheme::System),
            other => Err(format!("unknown window theme {other:?}; use \"light\", \"dark\" or \"system\"")),
        }
    }
}

/// Where the close button's top-left corner sits (logical points from the window's top-left), and how much horizontal room
/// the three buttons take, so the page can start its own content to the right of them.
pub const TRAFFIC_LIGHTS_POSITION: (f64, f64) = (20.0, 20.0);
pub const TRAFFIC_LIGHTS_INSET_LEFT: f64 = 84.0;
/// Height of the draggable header strip the web app should reserve at the top in app mode.
pub const TITLEBAR_HEIGHT: f64 = 52.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChromeSpec {
    pub mode: WindowMode,
    pub traffic_lights: bool,
    pub resizable: bool,
    pub size: (f64, f64),
    pub min_size: (f64, f64),
    /// Width the web app should leave free at the left of the header for the traffic lights (0 when they are hidden).
    pub titlebar_inset_left: f64,
    /// Height of the drag strip (0 when there is none).
    pub titlebar_height: f64,
}

/// Which native background sits behind the transparent webview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Effect {
    /// macOS 26+: `NSGlassEffectView`.
    LiquidGlass,
    /// `NSVisualEffectView` behind the window (macOS 10.14+).
    Vibrancy,
    /// Opaque window; the page paints its own background.
    None,
}

impl Effect {
    pub fn as_str(self) -> &'static str {
        match self {
            Effect::LiquidGlass => "liquid-glass",
            Effect::Vibrancy => "vibrancy",
            Effect::None => "none",
        }
    }
}

/// The best effect the platform supports, optionally capped by `DORKS_WINDOW_EFFECT` (`glass`, `vibrancy`, `none`; anything
/// else is ignored). The override can lower the effect but never request one the OS cannot draw.
pub fn choose_effect(is_macos: bool, glass_available: bool, override_value: Option<&str>) -> Effect {
    let best = if !is_macos {
        Effect::None
    } else if glass_available {
        Effect::LiquidGlass
    } else {
        Effect::Vibrancy
    };
    match (override_value.map(str::trim), best) {
        (Some("none"), _) => Effect::None,
        (Some("vibrancy"), Effect::LiquidGlass | Effect::Vibrancy) => Effect::Vibrancy,
        _ => best,
    }
}

/// What the page is told about its window: `window.__DORKS__.chrome`, plus attributes and CSS variables on `<html>`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeInfo {
    pub mode: WindowMode,
    /// The material that is actually behind the page (what is applied, not what was asked for).
    pub effect: Effect,
    pub traffic_lights: bool,
    /// Pixels to keep free at the left of the header for the traffic lights; `--titlebar-inset-left`.
    pub titlebar_inset_left: f64,
    /// Height of the header strip that should be draggable; `--titlebar-height`.
    pub titlebar_height: f64,
    /// The appearance the app asked for (`system` until it calls `set_window_theme`).
    pub theme: WindowTheme,
}

impl ChromeInfo {
    pub fn new(spec: ChromeSpec, effect: Effect, theme: WindowTheme) -> Self {
        Self {
            mode: spec.mode,
            effect,
            traffic_lights: spec.traffic_lights,
            titlebar_inset_left: spec.titlebar_inset_left,
            titlebar_height: spec.titlebar_height,
            theme,
        }
    }

    /// JavaScript that mirrors this onto `<html>` (`data-window-mode`, `data-window-effect`, `data-traffic-lights`,
    /// `--titlebar-inset-left`, `--titlebar-height`). It runs before the page's own scripts, when `<html>` may not exist yet,
    /// so it retries on `readystatechange`. Safe to run again after a mode change.
    pub fn page_script(&self) -> String {
        let json = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        format!(
            "(function(c){{var s=function(){{var r=document.documentElement;if(!r)return false;\
r.setAttribute('data-window-mode',c.mode);r.setAttribute('data-window-effect',c.effect);r.setAttribute('data-window-theme',c.theme);r.setAttribute('data-traffic-lights',String(c.trafficLights));\
r.style.setProperty('--titlebar-inset-left',c.titlebarInsetLeft+'px');r.style.setProperty('--titlebar-height',c.titlebarHeight+'px');return true;}};\
if(!s())document.addEventListener('readystatechange',s);}})({json});"
        )
    }
}

/// A remembered app-mode window frame, in logical points. Integers so settings stay `Eq`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Enough of the window must be on a screen for the user to grab it.
const MIN_VISIBLE_WIDTH: i64 = 120;
const MIN_VISIBLE_HEIGHT: i64 = 60;

/// Top-left position (logical points) that centres a window of `size` in `area` (a screen's usable area), never above or left
/// of the area's origin. Computed from the size we are about to have, not the one the window still reports mid-resize.
pub fn centered(size: (f64, f64), area: Rect) -> (i32, i32) {
    let x = f64::from(area.x) + (f64::from(area.width) - size.0) / 2.0;
    let y = f64::from(area.y) + (f64::from(area.height) - size.1) / 2.0;
    (x.round().max(f64::from(area.x)) as i32, y.round().max(f64::from(area.y)) as i32)
}

impl WindowFrame {
    /// The frame, clamped to at least `min_size`, or `None` when it is not on any of `screens` (a disconnected monitor, a
    /// corrupt file). `None` means: use the default size and centre.
    pub fn restorable(self, min_size: (f64, f64), screens: &[Rect]) -> Option<WindowFrame> {
        let frame = WindowFrame { width: self.width.max(min_size.0.ceil() as u32), height: self.height.max(min_size.1.ceil() as u32), ..self };
        screens.iter().any(|s| overlap(frame, *s)).then_some(frame)
    }
}

fn overlap(frame: WindowFrame, screen: Rect) -> bool {
    let left = i64::from(frame.x).max(i64::from(screen.x));
    let right = (i64::from(frame.x) + i64::from(frame.width)).min(i64::from(screen.x) + i64::from(screen.width));
    let top = i64::from(frame.y).max(i64::from(screen.y));
    let bottom = (i64::from(frame.y) + i64::from(frame.height)).min(i64::from(screen.y) + i64::from(screen.height));
    right - left >= MIN_VISIBLE_WIDTH && bottom - top >= MIN_VISIBLE_HEIGHT
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect { x: 0, y: 0, width: 1728, height: 1117 };

    #[test]
    fn modes_parse_print_and_default_to_onboarding() {
        assert_eq!("app".parse::<WindowMode>(), Ok(WindowMode::App));
        assert_eq!("onboarding".parse::<WindowMode>(), Ok(WindowMode::Onboarding));
        assert!("App".parse::<WindowMode>().is_err());
        assert_eq!(WindowMode::default(), WindowMode::Onboarding);
        assert_eq!(WindowMode::App.to_string(), "app");
        assert_eq!(serde_json::to_string(&WindowMode::Onboarding).unwrap(), "\"onboarding\"");
    }

    #[test]
    fn onboarding_is_fixed_without_lights_and_app_is_resizable_with_room_for_them() {
        let o = WindowMode::Onboarding.spec();
        assert!(!o.traffic_lights && !o.resizable);
        assert_eq!(o.size, o.min_size);
        assert_eq!((o.titlebar_inset_left, o.titlebar_height), (0.0, 0.0));

        let a = WindowMode::App.spec();
        assert!(a.traffic_lights && a.resizable);
        assert!(a.size.0 >= a.min_size.0 && a.size.1 >= a.min_size.1);
        assert!(a.titlebar_inset_left > TRAFFIC_LIGHTS_POSITION.0 + 3.0 * 12.0, "the inset must clear all three buttons");
        assert!(a.titlebar_height > TRAFFIC_LIGHTS_POSITION.1 + 12.0, "the strip must contain the buttons");
    }

    #[test]
    fn effect_follows_the_platform_and_the_override_can_only_lower_it() {
        assert_eq!(choose_effect(true, true, None), Effect::LiquidGlass);
        assert_eq!(choose_effect(true, false, None), Effect::Vibrancy);
        assert_eq!(choose_effect(false, true, None), Effect::None);
        assert_eq!(choose_effect(true, true, Some("vibrancy")), Effect::Vibrancy);
        assert_eq!(choose_effect(true, true, Some("none")), Effect::None);
        assert_eq!(choose_effect(true, false, Some("glass")), Effect::Vibrancy, "glass cannot be forced on an OS without it");
        assert_eq!(choose_effect(true, true, Some("glass")), Effect::LiquidGlass);
        assert_eq!(choose_effect(false, false, Some("vibrancy")), Effect::None);
        assert_eq!(choose_effect(true, true, Some("sparkles")), Effect::LiquidGlass);
    }

    #[test]
    fn chrome_info_serializes_camel_case_and_the_script_sets_attributes_and_variables() {
        let info = ChromeInfo::new(WindowMode::App.spec(), Effect::LiquidGlass, WindowTheme::Light);
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"mode\":\"app\""), "{json}");
        assert!(json.contains("\"effect\":\"liquid-glass\""), "{json}");
        assert!(json.contains("\"trafficLights\":true"), "{json}");
        assert!(json.contains("\"titlebarInsetLeft\":84.0"), "{json}");
        assert!(json.contains("\"theme\":\"light\""), "{json}");

        let script = info.page_script();
        for needle in ["data-window-mode", "data-window-effect", "data-window-theme", "data-traffic-lights", "--titlebar-inset-left", "--titlebar-height", "readystatechange"] {
            assert!(script.contains(needle), "{needle} missing from {script}");
        }
        assert!(script.ends_with(");"));

        let o = ChromeInfo::new(WindowMode::Onboarding.spec(), Effect::None, WindowTheme::System);
        assert!(serde_json::to_string(&o).unwrap().contains("\"trafficLights\":false"));
    }

    #[test]
    fn themes_parse_and_default_to_the_system() {
        assert_eq!(WindowTheme::default(), WindowTheme::System);
        for (s, t) in [("light", WindowTheme::Light), ("dark", WindowTheme::Dark), ("system", WindowTheme::System)] {
            assert_eq!(s.parse::<WindowTheme>(), Ok(t));
            assert_eq!(t.to_string(), s);
            assert_eq!(serde_json::to_string(&t).unwrap(), format!("\"{s}\""));
        }
        assert!("auto".parse::<WindowTheme>().is_err());
        assert!("Dark".parse::<WindowTheme>().is_err());
    }

    #[test]
    fn centring_uses_the_new_size_and_stays_inside_the_usable_area() {
        let area = Rect { x: 0, y: 38, width: 1680, height: 1012 };
        assert_eq!(centered((1200.0, 800.0), area), (240, 144));
        assert_eq!(centered((920.0, 680.0), area), (380, 204));
        let second = Rect { x: -1920, y: 0, width: 1920, height: 1080 };
        assert_eq!(centered((1200.0, 800.0), second), (-1560, 140));
        // Bigger than the area: pinned to its top-left corner, never off-screen to the left or above.
        assert_eq!(centered((2000.0, 1200.0), area), (0, 38));
    }

    #[test]
    fn a_remembered_frame_is_restored_only_when_it_is_on_a_screen() {
        let min = (900.0, 600.0);
        let ok = WindowFrame { x: 100, y: 80, width: 1300, height: 900 };
        assert_eq!(ok.restorable(min, &[SCREEN]), Some(ok));

        let tiny = WindowFrame { x: 100, y: 80, width: 100, height: 100 };
        assert_eq!(tiny.restorable(min, &[SCREEN]), Some(WindowFrame { x: 100, y: 80, width: 900, height: 600 }));

        let gone = WindowFrame { x: 4000, y: 80, width: 1300, height: 900 };
        assert_eq!(gone.restorable(min, &[SCREEN]), None, "second monitor unplugged");

        let hanging_off = WindowFrame { x: 1700, y: 80, width: 1300, height: 900 };
        assert_eq!(hanging_off.restorable(min, &[SCREEN]), None, "only 28 points of it on screen");

        let mostly_on = WindowFrame { x: 1000, y: 80, width: 1300, height: 900 };
        assert!(mostly_on.restorable(min, &[SCREEN]).is_some());

        assert_eq!(ok.restorable(min, &[]), None);
    }

    #[test]
    fn negative_coordinates_on_a_left_hand_monitor_work() {
        let left = Rect { x: -1920, y: 0, width: 1920, height: 1080 };
        let f = WindowFrame { x: -1800, y: 40, width: 1000, height: 700 };
        assert_eq!(f.restorable((900.0, 600.0), &[left, SCREEN]), Some(f));
    }
}
