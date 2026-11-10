//! Bringing the runtime up and down: secrets, ports, tunnel, sidecar supervision, window, keep-awake.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use dorks_shell_core::contract::*;
use dorks_shell_core::paths::Paths;
use dorks_shell_core::ports::pick_port;
use dorks_shell_core::secrets::{ensure_access_key, ensure_install_name, ensure_owner_token, read_secret};
use dorks_shell_core::settings::{KeepAwake, Settings};
use dorks_shell_core::supervisor::{reap_stale, Policy, SidecarSpec, Status, Supervisor};
use dorks_shell_core::tunnel::{self, Tunnel, TunnelError, TunnelHealth, TunnelTarget};
use dorks_shell_core::window::{ChromeInfo, Effect};
use dorks_shell_core::wurmhol::{find_wurmhol, WurmholConfig, WurmholTunnel};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::state::{AppState, Runtime, RuntimeConfig, TunnelInfo};
use crate::tray;
use crate::window;

pub const EVENT_STATUS: &str = "dorks://server-status";
pub const EVENT_CONFIG: &str = "dorks://runtime-config";
/// Wait this long after a lost tunnel before restarting, so a tunnel that keeps dying cannot spin.
const TUNNEL_RESTART_DELAY: Duration = Duration::from_secs(30);

/// Starts tunnel and server. On success the config is stored in [`AppState`]; on failure the reason is stored as the boot error.
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
    let bridge_port = pick_port(settings.bridge_port.or(Some(DEFAULT_BRIDGE_PORT)), &[ui_port]).map_err(|e| format!("no free port for the bridge: {e}"))?;
    if settings.ui_port != Some(ui_port) || settings.bridge_port != Some(bridge_port) {
        settings.ui_port = Some(ui_port);
        settings.bridge_port = Some(bridge_port);
        settings.save(&paths.settings_file()).map_err(|e| format!("cannot save settings: {e}"))?;
    }
    *state.settings.lock().unwrap() = settings.clone();

    let (tunnel, public_url, tunnel_info, tunnel_key) = start_tunnel(&settings, paths, bridge_port).await;

    let program = resolve_server_bin().ok_or_else(|| {
        format!("the {SERVER_BIN_NAME} sidecar was not found; run `pnpm --filter @dorks/desktop prepare:sidecar` or set {ENV_SERVER_BIN}")
    })?;
    let spec = server_spec(paths, program, ui_port, bridge_port, &owner_token, public_url.as_deref(), tunnel_key.as_deref());
    let supervisor = Arc::new(Supervisor::start(spec, Policy::default()));

    let tunnel_observable = matches!(tunnel_info.state.as_str(), "ready" | "approval");
    let config = RuntimeConfig {
        api_url: format!("http://127.0.0.1:{ui_port}"),
        ui_port,
        bridge_port,
        public_url,
        owner_token,
        data_dir: paths.server_data_dir().display().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        tunnel: tunnel_info,
    };
    *state.config.lock().unwrap() = Some(config.clone());
    let watcher = spawn_watcher(app.clone(), supervisor.clone());
    let tunnel_watcher = if tunnel_observable { tunnel.watch().map(|rx| spawn_tunnel_watcher(app.clone(), rx)) } else { None };
    *state.runtime.lock().await = Some(Runtime { supervisor, tunnel, watcher, tunnel_watcher });
    tray::refresh(app);
    Ok(config)
}

/// The wurmhol client's settings: the executable, the saved token, and the user's server and extra arguments.
fn wurmhol_config(settings: &Settings, paths: &Paths) -> WurmholConfig {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from));
    let bin = find_wurmhol(std::env::var_os(ENV_WURMHOL_BIN).as_deref(), exe_dir.as_deref(), std::env::var_os("PATH").as_deref(), home.as_deref())
        .unwrap_or_else(|| PathBuf::from("wurmhol"));
    let mut cfg = WurmholConfig::new(bin, paths.wurmhol_log());
    cfg.token = read_secret(&paths.wurmhol_token_file()).ok().flatten();
    cfg.access_key = ensure_access_key(&paths.wurmhol_access_key_file()).ok();
    cfg.server = settings.wurmhol_server.clone();
    cfg.extra_args = settings.wurmhol_args.clone();
    // A stable name keeps the public URL the same across restarts (sandboxes are created with it). The user's own `--name` wins.
    if !cfg.extra_args.iter().any(|a| a == "--name") {
        if let Ok(name) = ensure_install_name(&paths.wurmhol_name_file()) {
            cfg.extra_args.extend(["--name".to_string(), name]);
        }
    }
    cfg
}

async fn start_tunnel(settings: &Settings, paths: &Paths, bridge_port: u16) -> (Arc<dyn Tunnel>, Option<String>, TunnelInfo, Option<String>) {
    let env_url = std::env::var(ENV_PUBLIC_URL).ok();
    let cfg = wurmhol_config(settings, paths);
    let token_set = cfg.token.is_some();
    let tunnel: Arc<dyn Tunnel> = match tunnel::select(env_url.as_deref(), settings.public_url.as_deref(), cfg.clone()) {
        Ok(t) => Arc::from(t),
        Err(e) => {
            // A malformed URL: keep an idle wurmhol tunnel so the UI can still show the error.
            let idle: Arc<dyn Tunnel> = Arc::new(WurmholTunnel::new(cfg));
            return (idle, None, TunnelInfo { kind: "user-url".into(), state: "error".into(), error: Some(e.to_string()), approval_url: None, token_set }, None);
        }
    };
    // Only a wurmhol pipe needs the key; a URL the user supplies goes straight to the server.
    let tunnel_key = if tunnel.kind() == "wurmhol" { cfg.access_key.clone() } else { None };
    match tunnel.start(TunnelTarget { bridge_port }).await {
        Ok(endpoint) => {
            let info = TunnelInfo { kind: tunnel.kind().into(), state: "ready".into(), error: None, approval_url: None, token_set };
            (tunnel, Some(endpoint.public_url), info, tunnel_key)
        }
        Err(TunnelError::ApprovalNeeded(link)) => {
            let info = TunnelInfo { kind: tunnel.kind().into(), state: "approval".into(), error: None, approval_url: Some(link), token_set };
            (tunnel, None, info, tunnel_key)
        }
        Err(e) => {
            let info = TunnelInfo { kind: tunnel.kind().into(), state: "error".into(), error: Some(e.to_string()), approval_url: None, token_set };
            (tunnel, None, info, None)
        }
    }
}

/// When the tunnel reports it is gone: tell the UI, then restart the whole runtime after a delay, so the new public URL
/// (it may differ) reaches the server's environment and the UI. The restart runs as its own task: stopping the runtime
/// aborts this watcher.
fn spawn_tunnel_watcher(app: AppHandle, mut rx: tokio::sync::watch::Receiver<TunnelHealth>) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        rx.borrow_and_update();
        loop {
            if rx.changed().await.is_err() {
                return;
            }
            let health = rx.borrow_and_update().clone();
            let reason = match health {
                TunnelHealth::Approved => {
                    // Approval was granted: start again now (the same command prints the pipe's URL), not after the lost-tunnel delay.
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                            return;
                        }
                        stop_runtime(&app).await;
                        let _ = start_runtime(&app).await;
                        publish_config(&app);
                    });
                    return;
                }
                TunnelHealth::Lost(reason) => reason,
                TunnelHealth::Up => continue,
            };
            eprintln!("dorks: the tunnel is gone ({reason}); restarting in {} s", TUNNEL_RESTART_DELAY.as_secs());
            {
                let state = app.state::<AppState>();
                let mut config = state.config.lock().unwrap();
                if let Some(config) = config.as_mut() {
                    config.public_url = None;
                    config.tunnel.state = "lost".into();
                    config.tunnel.error = Some(reason);
                }
            }
            publish_config(&app);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(TUNNEL_RESTART_DELAY).await;
                if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    return;
                }
                stop_runtime(&app).await;
                let _ = start_runtime(&app).await;
                publish_config(&app);
            });
            return;
        }
    })
}

pub fn server_spec(paths: &Paths, program: PathBuf, ui_port: u16, bridge_port: u16, owner_token: &str, public_url: Option<&str>, tunnel_key: Option<&str>) -> SidecarSpec {
    let mut env = vec![
        (ENV_DATA_DIR.to_string(), paths.server_data_dir().display().to_string()),
        (ENV_OWNER_TOKEN.to_string(), owner_token.to_string()),
        (ENV_UI_PORT.to_string(), ui_port.to_string()),
        (ENV_BRIDGE_PORT.to_string(), bridge_port.to_string()),
        (ENV_PARENT_PID.to_string(), std::process::id().to_string()),
    ];
    if let Some(url) = public_url {
        env.push((ENV_PUBLIC_URL.to_string(), url.to_string()));
    }
    if let Some(key) = tunnel_key {
        env.push((ENV_TUNNEL_KEY.to_string(), key.to_string()));
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
    let exe = std::env::current_exe().ok()?;
    let sibling = exe.parent()?.join(SERVER_BIN_NAME);
    if sibling.is_file() {
        return Some(sibling);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let prefix = format!("{SERVER_BIN_NAME}-");
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

/// Stops the server (gracefully) and the tunnel. Safe to call twice.
pub async fn stop_runtime(app: &AppHandle) {
    let state = app.state::<AppState>();
    let runtime = state.runtime.lock().await.take();
    if let Some(runtime) = runtime {
        if let Some(w) = &runtime.tunnel_watcher {
            w.abort();
        }
        runtime.supervisor.shutdown().await;
        runtime.tunnel.stop().await;
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
        // No drop shadow: the material and the page draw the edge (see docs/desktop.md, "Shadow and border").
        .shadow(false)
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

/// Pushes a changed config to the open window (e.g. after the public URL was changed and the server restarted).
pub fn publish_config(app: &AppHandle) {
    let state = app.state::<AppState>();
    let window_config = state.window_config();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(window_config.init_script());
    }
    let _ = app.emit(EVENT_CONFIG, &window_config);
}
