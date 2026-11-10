//! Dorks desktop shell: a menu-bar app that supervises the `dorks-server` sidecar and shows the bundled UI.

mod boot;
mod commands;
mod state;
mod tray;
mod window;

use std::sync::atomic::Ordering;

use dorks_shell_core::paths::Paths;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use crate::state::AppState;

/// Graceful quit: stop the server and tunnel, then exit. Called from the tray and from Cmd+Q.
pub fn quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    window::flush(&app);
    tauri::async_runtime::spawn(async move {
        boot::stop_runtime(&app).await;
        app.state::<AppState>().shutdown_done.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| boot::show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let app = builder
        .manage(AppState::new(Paths::from_env()))
        .invoke_handler(tauri::generate_handler![
            commands::runtime_config,
            commands::server_status,
            commands::restart_server,
            commands::set_public_url,
            commands::set_wurmhol_token,
            commands::tunnel_status,
            commands::open_data_dir,
            commands::gh_status,
            commands::read_gh_token,
            commands::set_keep_awake,
            commands::keep_awake_mode,
            commands::set_keep_awake_mode,
            commands::window_chrome,
            commands::set_window_mode,
            commands::set_window_theme,
            commands::install_update,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if window::verification_mode() {
                // No Dock icon and no activation: a verification run must never take the user's screen or focus.
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            tray::build(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // The window is created once the server answers (or has failed), so the UI starts with a usable config.
                if boot::start_runtime(&handle).await.is_ok() {
                    let supervisor = handle.state::<AppState>().runtime.lock().await.as_ref().map(|r| r.supervisor.clone());
                    if let Some(supervisor) = supervisor {
                        use dorks_shell_core::supervisor::Status;
                        supervisor
                            .wait_for(|s| matches!(s, Status::Running | Status::Failed { .. }), std::time::Duration::from_secs(45))
                            .await;
                    }
                }
                let main_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || boot::show_main(&main_handle));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                // Closing the window leaves the app (and the server) running in the menu bar.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    window::remember_frame(window.app_handle());
                    window::flush(window.app_handle());
                    let _ = window.hide();
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => window::remember_frame(window.app_handle()),
                WindowEvent::Focused(true) => window::reassert(window.app_handle()),
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Dorks app");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            eprintln!("dorks: exit requested (code {code:?})");
            let state = app.state::<AppState>();
            if state.shutdown_done.load(Ordering::SeqCst) {
                return; // our own graceful quit finished
            }
            api.prevent_exit();
            if code.is_some() {
                quit(app); // Cmd+Q or the tray's Quit
            }
        }
        RunEvent::Exit => {
            // Last chance: macOS can terminate the app without an ExitRequested we could defer (for example a logout or
            // `tell application "Dorks" to quit`). Stop the server before the process goes.
            let state = app.state::<AppState>();
            if !state.shutdown_done.swap(true, Ordering::SeqCst) {
                eprintln!("dorks: exiting, stopping the server");
                tauri::async_runtime::block_on(boot::stop_runtime(app));
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => boot::show_main(app),
        _ => {}
    });
}
