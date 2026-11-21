//! Menu-bar status item: server state, plus the few actions that matter without opening the window.

use dorks_shell_core::supervisor::Status;
use tauri::image::Image;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::boot;
use crate::updater::{self, UpdateStatus, Updater};
use crate::state::AppState;

const TRAY_ID: &str = "dorks";

pub struct TrayItems {
    server: MenuItem<tauri::Wry>,
    /// Only in builds that can update themselves.
    update: Option<MenuItem<tauri::Wry>>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let server = MenuItem::with_id(app, "server", server_line(&Status::Starting), false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Dorks", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "Open Data Folder", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open Server Log", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Server", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Dorks", true, Some("Cmd+Q"))?;
    let status = app.state::<Updater>().status();
    let update = match status {
        UpdateStatus::Unsupported => None,
        _ => Some(MenuItem::with_id(app, "update", update_line(&status).0, true, None::<&str>)?),
    };
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&server, &separator, &open];
    if let Some(update) = &update {
        items.push(update);
    }
    items.extend([&data as &dyn IsMenuItem<tauri::Wry>, &logs, &restart, &separator2, &quit]);
    let menu = Menu::with_items(app, &items)?;
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
            "update" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    match app.state::<Updater>().status() {
                        UpdateStatus::Available { .. } | UpdateStatus::Failed { .. } => {
                            let _ = updater::install(&app).await;
                        }
                        _ => {
                            if let Ok(UpdateStatus::Idle { .. }) = updater::check(&app).await {
                                say_up_to_date(&app).await;
                            }
                        }
                    }
                });
            }
            "quit" => crate::quit(app),
            _ => {}
        })
        .build(app)?;
    app.manage(TrayItems { server, update });
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

/// Re-renders the menu texts and tooltip from the current state.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<AppState>();
    let status = state.status.lock().unwrap().clone();
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.server.set_text(server_line(&status));
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("Dorks – {}", server_line(&status).to_lowercase())));
    }
}

/// The update item's text and whether it can be chosen.
pub fn update_line(status: &UpdateStatus) -> (String, bool) {
    match status {
        UpdateStatus::Unsupported | UpdateStatus::Idle { checking: false } => ("Check for Updates…".into(), true),
        UpdateStatus::Idle { checking: true } => ("Checking for Updates…".into(), false),
        UpdateStatus::Available { version, .. } | UpdateStatus::Failed { version, .. } => (format!("Update to Dorks {version}…"), true),
        UpdateStatus::Downloading { downloaded, total: Some(total), .. } if *total > 0 => {
            (format!("Downloading Update… {}%", downloaded * 100 / total), false)
        }
        UpdateStatus::Downloading { .. } => ("Downloading Update…".into(), false),
        UpdateStatus::Installing { .. } => ("Installing Update…".into(), false),
    }
}

pub fn refresh_update(app: &AppHandle, status: &UpdateStatus) {
    if let Some(item) = app.try_state::<TrayItems>().and_then(|items| items.update.clone()) {
        let (text, enabled) = update_line(status);
        let _ = item.set_text(text);
        let _ = item.set_enabled(enabled);
    }
}

/// After a check asked for from the menu found nothing: say so in the item for a few seconds.
async fn say_up_to_date(app: &AppHandle) {
    let Some(item) = app.try_state::<TrayItems>().and_then(|items| items.update.clone()) else { return };
    let _ = item.set_text("Dorks Is Up to Date");
    let _ = item.set_enabled(false);
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    refresh_update(app, &app.state::<Updater>().status());
}
