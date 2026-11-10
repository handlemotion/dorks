//! Commands the UI can invoke (`invoke('name')` from `@tauri-apps/api/core`).

use std::sync::atomic::Ordering;

use dorks_shell_core::github::{self, GhStatus};
use dorks_shell_core::secrets::write_secret;
use dorks_shell_core::settings::{validate_public_url, KeepAwake};
use dorks_shell_core::supervisor::Status;
use dorks_shell_core::window::{ChromeInfo, WindowMode, WindowTheme};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::boot;
use crate::window;
use crate::state::{AppState, RuntimeConfig, TunnelInfo};

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

/// Saves (or, with `None`, clears) the user-supplied public URL and restarts tunnel and server so the new URL takes effect.
#[tauri::command]
pub async fn set_public_url(app: AppHandle, url: Option<String>) -> Result<Option<RuntimeConfig>, String> {
    let url = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    let normalised = url.as_deref().map(validate_public_url).transpose()?;
    {
        let state = app.state::<AppState>();
        let mut settings = state.settings.lock().unwrap();
        settings.public_url = normalised;
        settings.save(&state.paths.settings_file()).map_err(|e| format!("cannot save settings: {e}"))?;
    }
    restart_runtime(&app).await.map(Some)
}

async fn restart_runtime(app: &AppHandle) -> Result<RuntimeConfig, String> {
    boot::stop_runtime(app).await;
    let result = boot::start_runtime(app).await;
    boot::publish_config(app);
    result
}

/// Saves (or, with `None`, removes) the wurmhol token and restarts tunnel and server. The token is kept in a 0600 file and is
/// never returned to the UI; `tunnel.tokenSet` says whether one exists.
#[tauri::command]
pub async fn set_wurmhol_token(app: AppHandle, token: Option<String>) -> Result<Option<RuntimeConfig>, String> {
    let token = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if let Some(t) = &token {
        if t.len() > 512 || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("that does not look like a wurmhol token".into());
        }
    }
    let path = app.state::<AppState>().paths.wurmhol_token_file();
    write_secret(&path, token.as_deref()).map_err(|e| format!("cannot save the token: {e}"))?;
    restart_runtime(&app).await.map(Some)
}

#[tauri::command]
pub fn tunnel_status(state: State<'_, AppState>) -> Option<TunnelInfo> {
    state.config.lock().unwrap().as_ref().map(|c| c.tunnel.clone())
}

#[tauri::command]
pub fn open_data_dir(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    app.opener().open_path(state.paths.root().display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gh_status() -> GhStatus {
    github::status().await
}

/// Reads the token of the user's `gh` CLI. A native dialog asks first, because the token ends up in cloud sandboxes; the
/// UI cannot skip or auto-answer it. `Err("consent_denied")` if declined, `Ok(None)` if `gh` is missing or logged out.
#[tauri::command]
pub async fn read_gh_token(app: AppHandle) -> Result<Option<String>, String> {
    let dialog_app = app.clone();
    let allowed = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message(
                "Dorks wants to read the GitHub token from your GitHub CLI (`gh auth token`).\n\n\
                 It is stored on this Mac and sent to the Boat sandboxes that run your dorks, so agents there can push and \
                 open pull requests as you. It carries all the access your gh login has. A token limited to the repositories \
                 you choose is safer.",
            )
            .title("Share your GitHub CLI token?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Cancel".into()))
            .blocking_show()
    })
    .await
    .map_err(|e| e.to_string())?;
    if !allowed {
        return Err("consent_denied".into());
    }
    Ok(github::read_token().await)
}

/// The UI reports whether dorks are working. With the default setting the Mac is kept awake only then.
#[tauri::command]
pub fn set_keep_awake(app: AppHandle, state: State<'_, AppState>, active: bool) -> bool {
    state.ui_active.store(active, Ordering::SeqCst);
    boot::apply_keep_awake(&app);
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

/// Checks for an update and installs it. Real only in builds with the `updater` feature (the release workflow).
#[cfg(feature = "updater")]
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let Some(update) = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let version = update.version.clone();
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    Ok(Some(version))
}

#[cfg(not(feature = "updater"))]
#[tauri::command]
pub async fn install_update() -> Result<Option<String>, String> {
    Err("updates are not enabled in this build".into())
}
