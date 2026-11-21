//! Bringing the runtime up and down: secrets, port, sidecar supervision, window, keep-awake.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use dorks_shell_core::contract::*;
use dorks_shell_core::paths::Paths;
use dorks_shell_core::ports::pick_port;
use dorks_shell_core::secrets::{ensure_owner_token, write_secret};
use dorks_shell_core::settings::{KeepAwake, Settings};
use dorks_shell_core::supervisor::{reap_stale, Policy, SidecarSpec, Status, Supervisor};
use dorks_shell_core::window::{ChromeInfo, Effect};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::state::{AppState, Runtime, RuntimeConfig};
use crate::tray;
use crate::window;

pub const EVENT_STATUS: &str = "dorks://server-status";
pub const EVENT_CONFIG: &str = "dorks://runtime-config";

/// Starts the server. On success the config is stored in [`AppState`]; on failure the reason is stored as the boot error.
pub async fn start_runtime(app: &AppHandle) -> Result<RuntimeConfig, String> {
    let state = app.state::<AppState>();
    let result = try_start(app, &state).await;
    match &result {
        Ok(_) => *state.boot_error.lock().unwrap() = None,
        Err(e) => {
            eprintln!("dorks: could not start: {e}");
            *state.boot_error.lock().unwrap() = Some(e.clone());
            *state.config.lock().unwrap() = None;
        }
    }
    result
}

async fn try_start(app: &AppHandle, state: &AppState) -> Result<RuntimeConfig, String> {
    let paths = &state.paths;
    paths.ensure().map_err(|e| format!("cannot create {}: {e}", paths.root().display()))?;
    let pid_file = paths.server_pid_file();
    let _ = tauri::async_runtime::spawn_blocking(move || reap_stale(&pid_file, SERVER_BIN_NAME, Duration::from_secs(3))).await;

    let mut settings = Settings::load(&paths.settings_file()).map_err(|e| format!("{e}; fix or delete that file"))?;
    let owner_token = ensure_owner_token(&paths.owner_token_file()).map_err(|e| e.to_string())?;
    let ui_port = pick_port(settings.ui_port.or(Some(DEFAULT_UI_PORT)), &[]).map_err(|e| format!("no free port for the UI: {e}"))?;
    if settings.ui_port != Some(ui_port) {
        settings.ui_port = Some(ui_port);
        settings.save(&paths.settings_file()).map_err(|e| format!("cannot save settings: {e}"))?;
    }
    *state.settings.lock().unwrap() = settings.clone();

    // The server dials out to each sandbox now; the removed tunnel's key, connector and log are not needed.
    for legacy in paths.legacy_tunnel_files() {
        let _ = write_secret(&legacy, None);
    }

    let program = resolve_server_bin().ok_or_else(|| {
        format!("the {SERVER_BIN_NAME} sidecar was not found; run `pnpm --filter @dorks/desktop prepare:sidecar` or set {ENV_SERVER_BIN}")
    })?;
    let spec = server_spec(paths, program, ui_port, &owner_token);
    let supervisor = Arc::new(Supervisor::start(spec, Policy::default()));

    let config = RuntimeConfig {
        api_url: format!("http://127.0.0.1:{ui_port}"),
        ui_port,
        owner_token,
        data_dir: paths.server_data_dir().display().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
    *state.config.lock().unwrap() = Some(config.clone());
    let watcher = spawn_watcher(app.clone(), supervisor.clone());
    *state.runtime.lock().await = Some(Runtime { supervisor, watcher });
    tray::refresh(app);
    Ok(config)
}

pub fn server_spec(paths: &Paths, program: PathBuf, ui_port: u16, owner_token: &str) -> SidecarSpec {
    let env = vec![
        (ENV_DATA_DIR.to_string(), paths.server_data_dir().display().to_string()),
        (ENV_OWNER_TOKEN.to_string(), owner_token.to_string()),
        (ENV_UI_PORT.to_string(), ui_port.to_string()),
        (ENV_PARENT_PID.to_string(), std::process::id().to_string()),
    ];
    if let Some(boat) = resolve_bundled_bin(BOAT_BIN_NAME) {
        env.push((ENV_BOAT_BIN.to_string(), boat.display().to_string()));
    }
    SidecarSpec {
        program,
        args: vec![],
        env,
        log_file: paths.server_log(),
        pid_file: Some(paths.server_pid_file()),
        health_port: ui_port,
        health_path: HEALTH_PATH.to_string(),
    }
}

/// `$DORKS_SERVER_BIN`; else `dorks-server` next to the app executable (where Tauri puts externalBin in a bundle); else the
/// development copy in `src-tauri/binaries`.
pub fn resolve_server_bin() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(ENV_SERVER_BIN).map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(path);
    }
    resolve_bundled_bin(SERVER_BIN_NAME)
}

/// An externalBin: next to the app executable (where Tauri puts it in a bundle), else the development copy in `src-tauri/binaries`.
fn resolve_bundled_bin(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let sibling = exe.parent()?.join(name);
    if sibling.is_file() {
        return Some(sibling);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let prefix = format!("{name}-");
    std::fs::read_dir(dev)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&prefix)) && p.is_file())
}

/// Forwards status changes to the tray and the UI, and keeps the keep-awake assertion in step.
fn spawn_watcher(app: AppHandle, supervisor: Arc<Supervisor>) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut rx = supervisor.watch();
        loop {
            let status = rx.borrow_and_update().clone();
            *app.state::<AppState>().status.lock().unwrap() = status.clone();
            let _ = app.emit(EVENT_STATUS, &status);
            tray::refresh(&app);
            apply_keep_awake(&app);
            if rx.changed().await.is_err() {
                break;
            }
        }
    })
}

/// Holds the power assertion when the settings and the UI's activity signal ask for it and the server is running.
pub fn apply_keep_awake(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mode = state.settings.lock().unwrap().keep_awake;
    let running = matches!(*state.status.lock().unwrap(), Status::Running);
    let active = state.ui_active.load(Ordering::SeqCst);
    let want = running
        && match mode {
            KeepAwake::Always => true,
            KeepAwake::Never => false,
            KeepAwake::WhileActive => active,
        };
    state.keep_awake.lock().unwrap().set(want);
}

/// Stops the server (gracefully). Safe to call twice.
pub async fn stop_runtime(app: &AppHandle) {
    let state = app.state::<AppState>();
    let runtime = state.runtime.lock().await.take();
    if let Some(runtime) = runtime {
        runtime.supervisor.shutdown().await;
        runtime.watcher.abort();
    }
    state.keep_awake.lock().unwrap().set(false);
    *state.status.lock().unwrap() = Status::Stopped;
}

/// Creates the main window with the runtime config injected, or shows it if it exists.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        if !window::verification_mode() {
            let _ = window.set_focus();
        }
        return;
    }
    let state = app.state::<AppState>();
    // Open in the chrome the window had last time (the web app sets it with `set_window_mode`); a fresh install has none and
    // starts in onboarding. The window stays hidden until its material and geometry are in place, so nothing flashes.
    let (mode, theme) = {
        let settings = state.settings.lock().unwrap();
        (settings.window_mode, settings.window_theme)
    };
    let spec = mode.spec();
    let wanted = window::detect_effect();
    *state.chrome.lock().unwrap() = ChromeInfo::new(spec, wanted, theme);
    let script = state.window_config().init_script();
    let handle = app.clone();
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Dorks")
        .inner_size(spec.size.0, spec.size.1)
        .min_inner_size(spec.min_size.0, spec.min_size.1)
        .resizable(spec.resizable)
        .visible(false)
        .focused(!window::verification_mode())
        .theme(window::tauri_theme(theme))
        .initialization_script(script)
        .on_navigation(move |url| allow_navigation(&handle, url));
    // A transparent webview is what lets the material show through the page; only ask for it when there is one behind it.
    #[cfg(target_os = "macos")]
    let builder = builder
        .transparent(wanted != Effect::None)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // The native window shadow, like every other Mac window (docs/desktop.md, "Shadow and border").
        .shadow(true)
        .traffic_light_position(window::traffic_light_position());
    match builder.build() {
        Ok(win) => window::finish(app, &win, mode, theme, wanted),
        Err(e) => eprintln!("dorks: could not create the window: {e}"),
    }
}

/// The window only ever shows the bundled UI. Other http(s) links open in the browser instead.
fn allow_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    let local = matches!(url.scheme(), "tauri" | "about" | "data" | "blob")
        || (matches!(url.scheme(), "http" | "https") && matches!(url.host_str(), Some("tauri.localhost" | "localhost")));
    if !local && matches!(url.scheme(), "http" | "https") {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    local
}

/// Pushes a changed config to the open window (e.g. after the window chrome changed).
pub fn publish_config(app: &AppHandle) {
    let state = app.state::<AppState>();
    let window_config = state.window_config();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(window_config.init_script());
    }
    let _ = app.emit(EVENT_CONFIG, &window_config);
}
