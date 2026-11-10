//! Menu-bar status item: server and tunnel state, plus the few actions that matter without opening the window.

use dorks_shell_core::supervisor::Status;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::boot;
use crate::state::AppState;

const TRAY_ID: &str = "dorks";

pub struct TrayItems {
    server: MenuItem<tauri::Wry>,
    tunnel: MenuItem<tauri::Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let server = MenuItem::with_id(app, "server", server_line(&Status::Starting), false, None::<&str>)?;
    let tunnel = MenuItem::with_id(app, "tunnel", "Tunnel: not started", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Dorks", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "Open Data Folder", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open Server Log", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Server", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Dorks", true, Some("Cmd+Q"))?;
    let menu = Menu::with_items(
        app,
        &[
            &server,
            &tunnel,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &data,
            &logs,
            &restart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Dorks")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => boot::show_main(app),
            "data" => {
                let dir = app.state::<AppState>().paths.root().to_path_buf();
                let _ = app.opener().open_path(dir.display().to_string(), None::<&str>);
            }
            "logs" => {
                let log = app.state::<AppState>().paths.server_log();
                let _ = app.opener().reveal_item_in_dir(log);
            }
            "restart" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(runtime) = app.state::<AppState>().runtime.lock().await.as_ref() {
                        runtime.supervisor.restart();
                    }
                });
            }
            "quit" => crate::quit(app),
            _ => {}
        })
        .build(app)?;
    app.manage(TrayItems { server, tunnel });
    Ok(())
}

/// One-line server state for the menu.
pub fn server_line(status: &Status) -> String {
    match status {
        Status::Stopped => "Server: stopped".into(),
        Status::Starting => "Server: starting…".into(),
        Status::Running => "Server: running".into(),
        Status::Restarting { attempt, .. } => format!("Server: restarting (attempt {attempt})"),
        Status::Failed { .. } => "Server: failed, choose Restart Server".into(),
    }
}

pub fn tunnel_line(kind: Option<&str>, state: Option<&str>) -> String {
    match (kind, state) {
        (Some(kind), Some("ready")) => format!("Tunnel: {kind} connected"),
        (Some(kind), Some(_)) => format!("Tunnel: {kind} unavailable"),
        _ => "Tunnel: not started".into(),
    }
}

/// Re-renders the menu texts and tooltip from the current state.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<AppState>();
    let status = state.status.lock().unwrap().clone();
    let (kind, tunnel_state) = state
        .config
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| (Some(c.tunnel.kind.clone()), Some(c.tunnel.state.clone())))
        .unwrap_or((None, None));
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.server.set_text(server_line(&status));
        let _ = items.tunnel.set_text(tunnel_line(kind.as_deref(), tunnel_state.as_deref()));
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("Dorks – {}", server_line(&status).to_lowercase())));
    }
}
