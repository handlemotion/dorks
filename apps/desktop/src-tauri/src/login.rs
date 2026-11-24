//! Keeping scheduled automations on time from the shell's side (docs/desktop.md, "Open at login" and "Keep awake").
//!
//! - Open at login: while an active automation has a schedule the app is a login item (`SMAppService.mainApp`, macOS 13+), so a
//!   reboot or a fresh login does not leave the server, and every schedule with it, off until someone opens the app.
//! - App Nap: while the keep-awake assertion is held the app also holds an `NSProcessInfo` activity, so macOS does not nap the
//!   shell (and with it the supervisor's health checks) behind a hidden window and a dark display.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use dorks_shell_core::login::{login_item_change, LoginItemChange};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// The UI's last report of whether an active automation has a schedule; None until it says (an older UI never does).
static SCHEDULED: Mutex<Option<bool>> = Mutex::new(None);

/// Records the UI's report and adds or removes the login item to match. A failure (an unsigned dev build, macOS 12) is logged and
/// retried on the next report.
pub fn set_scheduled(app: &AppHandle, scheduled: Option<bool>) {
    let Some(scheduled) = scheduled else { return };
    {
        let mut last = SCHEDULED.lock().unwrap();
        if *last == Some(scheduled) {
            return;
        }
        *last = Some(scheduled);
    }
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().unwrap();
    let Some(change) = login_item_change(settings.open_at_login, scheduled, settings.login_item_registered) else { return };
    match native::apply(change) {
        Ok(()) => {
            settings.login_item_registered = change == LoginItemChange::Register;
            if let Err(e) = settings.save(&state.paths.settings_file()) {
                eprintln!("dorks: cannot save settings: {e}");
            }
            eprintln!("dorks: login item {}", if change == LoginItemChange::Register { "added" } else { "removed" });
        }
        Err(e) => {
            eprintln!("dorks: login item not {}: {e}", if change == LoginItemChange::Register { "added" } else { "removed" });
            *SCHEDULED.lock().unwrap() = None; // try again on the next report
        }
    }
}

static NAP_HELD: AtomicBool = AtomicBool::new(false);

/// Holds (or ends) the activity that keeps App Nap off. Idempotent.
pub fn set_no_nap(hold: bool) {
    if NAP_HELD.swap(hold, Ordering::SeqCst) != hold {
        native::set_no_nap(hold);
    }
}

#[cfg(target_os = "macos")]
mod native {
    use std::sync::Mutex;

    use dorks_shell_core::login::LoginItemChange;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    use objc2_service_management::SMAppService;

    pub fn apply(change: LoginItemChange) -> Result<(), String> {
        if !objc2::available!(macos = 13.0) {
            return Err("needs macOS 13".into());
        }
        // SAFETY: plain SMAppService calls on the app's own main-app service; no pointers cross.
        unsafe {
            let service = SMAppService::mainAppService();
            let result = match change {
                LoginItemChange::Register => service.registerAndReturnError(),
                LoginItemChange::Unregister => service.unregisterAndReturnError(),
            };
            result.map_err(|e| e.localizedDescription().to_string())
        }
    }

    /// The activity token. NSProcessInfo activities may be ended from any thread.
    struct Activity(Retained<ProtocolObject<dyn NSObjectProtocol>>);
    // SAFETY: the token is only handed back to `endActivity`, which Foundation documents as thread-safe.
    unsafe impl Send for Activity {}

    static ACTIVITY: Mutex<Option<Activity>> = Mutex::new(None);

    pub fn set_no_nap(hold: bool) {
        let info = NSProcessInfo::processInfo();
        let mut slot = ACTIVITY.lock().unwrap();
        if hold {
            if slot.is_none() {
                // User-initiated work, but idle sleep stays the caffeinate assertion's call (the `never` setting can allow it).
                let reason = NSString::from_str("Dorks is running sessions or has automations scheduled");
                *slot = Some(Activity(info.beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &reason)));
            }
        } else if let Some(Activity(token)) = slot.take() {
            // SAFETY: the token came from `beginActivityWithOptions_reason` on this process and is ended once.
            unsafe { info.endActivity(&token) };
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use dorks_shell_core::login::LoginItemChange;

    pub fn apply(_change: LoginItemChange) -> Result<(), String> {
        Err("only on macOS".into())
    }

    pub fn set_no_nap(_hold: bool) {}
}
