//! Commands the UI can invoke (`invoke('name')` from `@tauri-apps/api/core`).

use std::sync::atomic::Ordering;

use dorks_shell_core::settings::KeepAwake;
use dorks_shell_core::supervisor::Status;
use dorks_shell_core::window::{ChromeInfo, WindowMode, WindowTheme};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::boot;
use crate::updater::{self, UpdateStatus, Updater};
use crate::window;
use crate::state::{AppState, RuntimeConfig};

#[tauri::command]
pub fn runtime_config(state: State<'_, AppState>) -> Option<RuntimeConfig> {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn server_status(state: State<'_, AppState>) -> Status {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
pub async fn restart_server(state: State<'_, AppState>) -> Result<(), String> {
    match state.runtime.lock().await.as_ref() {
        Some(runtime) => {
            runtime.supervisor.restart();
            Ok(())
        }
        None => Err("the server is not set up; see the boot error".into()),
    }
}

#[tauri::command]
pub fn open_data_dir(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    app.opener().open_path(state.paths.root().display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

/// Opens an external web or mailto link in the OS default browser. Used by the UI on single-click in the desktop webview,
/// where WKWebView can swallow `target="_blank"` clicks unless invoked directly.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(format!("unsupported url scheme: {}", parsed.scheme()));
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

/// The UI reports whether dorks are working, and whether an active automation has a schedule (`scheduled`, absent from older UIs).
/// With the default settings the Mac is kept awake only while either holds, and the app opens at login while a schedule exists.
#[tauri::command]
pub fn set_keep_awake(app: AppHandle, state: State<'_, AppState>, active: bool, scheduled: Option<bool>) -> bool {
    state.ui_active.store(active, Ordering::SeqCst);
    boot::apply_keep_awake(&app);
    crate::login::set_scheduled(&app, scheduled);
    state.keep_awake.lock().unwrap().is_active()
}

#[tauri::command]
pub fn keep_awake_mode(state: State<'_, AppState>) -> KeepAwake {
    state.settings.lock().unwrap().keep_awake
}

#[tauri::command]
pub fn set_keep_awake_mode(app: AppHandle, state: State<'_, AppState>, mode: KeepAwake) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap();
        settings.keep_awake = mode;
        settings.save(&state.paths.settings_file()).map_err(|e| format!("cannot save settings: {e}"))?;
    }
    boot::apply_keep_awake(&app);
    Ok(())
}

/// The window chrome the UI is in right now (`window.__DORKS__.chrome` is the same value at load time).
#[tauri::command]
pub fn window_chrome(state: State<'_, AppState>) -> ChromeInfo {
    state.chrome.lock().unwrap().clone()
}

/// Switches the window between `"onboarding"` (no traffic lights, fixed size, centred) and `"app"` (traffic lights over the
/// content, resizable, remembered frame). The shell remembers the mode for the next launch. Returns the new chrome.
///
/// Deliberately not `async`: Tauri runs plain commands on the main thread, which is where AppKit wants to be touched.
#[tauri::command]
pub fn set_window_mode(app: AppHandle, mode: String) -> Result<ChromeInfo, String> {
    let mode = mode.parse::<WindowMode>()?;
    window::set_mode(&app, mode)
}

/// Sets the window appearance: `"light"`, `"dark"`, or `"system"` (follow macOS, the default). The native material behind the
/// page and the page's `prefers-color-scheme` follow it, so call it whenever the app's theme changes. Remembered across
/// launches. Returns the new chrome. Not `async`, for the same main-thread reason as `set_window_mode`.
#[tauri::command]
pub fn set_window_theme(app: AppHandle, theme: String) -> Result<ChromeInfo, String> {
    let theme = theme.parse::<WindowTheme>()?;
    window::set_theme(&app, theme)
}

/// Where the in-app update stands (see `updater.rs`); `dorks://update` carries every change.
#[tauri::command]
pub fn update_status(updater: State<'_, Updater>) -> UpdateStatus {
    updater.status()
}

/// Checks GitHub for a newer version now and returns the resulting status.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateStatus, String> {
    updater::check(&app).await
}

/// Downloads and installs the offered update, then relaunches the app (the server is stopped first). Progress arrives as
/// `dorks://update` events; the call only returns if it failed.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    updater::install(&app).await
}

/// The UI route of the last `dorks://` link (see `deep_link.rs`), once: the UI asks when it has loaded, so a link that launched the
/// app is not lost before anything listened for `dorks://open-route`.
#[tauri::command]
pub fn take_open_route(state: tauri::State<'_, crate::state::AppState>) -> Option<String> {
    state.open_route.lock().unwrap().take()
}
