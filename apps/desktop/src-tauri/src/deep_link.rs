//! `dorks://` links (docs/desktop.md, "Links"): macOS opens the app with them (`tauri-plugin-deep-link`, the scheme registered from
//! `tauri.conf.json`). Each is mapped to a UI route by `dorks_shell_core::deep_link::route_for`; anything else is ignored.
//!
//! A link can arrive before the window exists (it launched the app) or while it is open. So the route is kept until the UI takes it
//! (`take_open_route`, which the UI calls once it has loaded) and also sent as `dorks://open-route` to a UI that is already listening.
//! Either way the window is shown.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::{boot, state::AppState};

pub const EVENT_OPEN_ROUTE: &str = "dorks://open-route";

/// Starts listening for links, and handles the one the app was launched with, if any.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            open(&handle, url.as_str());
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            open(app, url.as_str());
        }
    }
}

fn open(app: &AppHandle, url: &str) {
    let Some(route) = dorks_shell_core::deep_link::route_for(url) else {
        eprintln!("dorks: ignoring a link this app does not open");
        return;
    };
    *app.state::<AppState>().open_route.lock().unwrap() = Some(route.clone());
    let _ = app.emit(EVENT_OPEN_ROUTE, route);
    let main = app.clone();
    let _ = app.run_on_main_thread(move || boot::show_main(&main));
}
