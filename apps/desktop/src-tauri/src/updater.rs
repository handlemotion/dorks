//! In-app updates from GitHub Releases (docs/desktop.md, "Updates").
//!
//! The shell checks `latest.json` on the latest published release shortly after launch and every 15 minutes, and keeps one
//! [`UpdateStatus`] that the UI reads (`update_status`) and follows (`dorks://update`). Installing downloads the signed bundle,
//! replaces the app, stops the server and relaunches. Only builds with the `updater` feature (the release workflow) can update;
//! every other build reports `unsupported` and the UI shows nothing.

use std::sync::Mutex;
#[cfg(feature = "updater")]
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const EVENT_UPDATE: &str = "dorks://update";

#[cfg(feature = "updater")]
const FIRST_CHECK: Duration = Duration::from_secs(10);
#[cfg(feature = "updater")]
/// A check is one small `latest.json` from GitHub's CDN, so a release reaches open apps within minutes, not hours.
const CHECK_EVERY: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[cfg_attr(not(feature = "updater"), allow(dead_code))] // only release builds reach the later states
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UpdateStatus {
    /// This build cannot update itself (a local or unsigned build).
    Unsupported,
    /// No update known. `checking` while a check runs.
    Idle { checking: bool },
    /// A newer version is published.
    Available { version: String, notes: Option<String> },
    /// Downloading it; `total` is unknown when the server sends no length.
    Downloading { version: String, downloaded: u64, total: Option<u64> },
    /// Downloaded and being put in place, then the app relaunches.
    Installing { version: String },
    /// Installing failed; the update is still offered.
    Failed { version: String, message: String },
}

pub struct Updater {
    status: Mutex<UpdateStatus>,
    #[cfg(feature = "updater")]
    pending: tokio::sync::Mutex<Option<tauri_plugin_updater::Update>>,
    /// Held by a check, and by an install from start to relaunch, so a check can never land in the middle of an install and
    /// offer the update again.
    #[cfg(feature = "updater")]
    busy: tokio::sync::Mutex<()>,
    /// Set while an install is wanted or running, so a second Update click does nothing.
    #[cfg(feature = "updater")]
    installing: std::sync::atomic::AtomicBool,
}

impl Updater {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(if cfg!(feature = "updater") { UpdateStatus::Idle { checking: false } } else { UpdateStatus::Unsupported }),
            #[cfg(feature = "updater")]
            pending: tokio::sync::Mutex::new(None),
            #[cfg(feature = "updater")]
            busy: tokio::sync::Mutex::new(()),
            #[cfg(feature = "updater")]
            installing: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> UpdateStatus {
        self.status.lock().unwrap().clone()
    }
}

#[cfg_attr(not(feature = "updater"), allow(dead_code))]
fn set(app: &AppHandle, status: UpdateStatus) {
    let changed = {
        let updater = app.state::<Updater>();
        let mut current = updater.status.lock().unwrap();
        let changed = *current != status;
        *current = status.clone();
        changed
    };
    if changed {
        let _ = app.emit(EVENT_UPDATE, &status);
        crate::tray::refresh_update(app, &status);
    }
}

/// Checks now and every 15 minutes after a short delay (release builds only).
pub fn start_background_checks(app: &AppHandle) {
    #[cfg(feature = "updater")]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(FIRST_CHECK).await;
            loop {
                let _ = check(&app).await;
                tokio::time::sleep(CHECK_EVERY).await;
            }
        });
    }
    #[cfg(not(feature = "updater"))]
    let _ = app;
}

/// Asks GitHub for a newer version. While another check or an install runs it does nothing and returns the current status. A
/// failed check is logged and changes nothing the UI shows (being offline is not worth a banner); the error is returned to
/// whoever asked.
#[cfg(feature = "updater")]
pub async fn check(app: &AppHandle) -> Result<UpdateStatus, String> {
    let updater = app.state::<Updater>();
    let Ok(_busy) = updater.busy.try_lock() else {
        return Ok(updater.status());
    };
    check_locked(app).await
}

/// The check itself; the caller holds `busy`.
#[cfg(feature = "updater")]
async fn check_locked(app: &AppHandle) -> Result<UpdateStatus, String> {
    use tauri_plugin_updater::UpdaterExt;

    let before = app.state::<Updater>().status();
    if matches!(before, UpdateStatus::Downloading { .. } | UpdateStatus::Installing { .. }) {
        return Ok(before);
    }
    if matches!(before, UpdateStatus::Idle { .. }) {
        set(app, UpdateStatus::Idle { checking: true });
    }
    let found = async { app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string()) }.await;
    let after = match found {
        Ok(Some(update)) => {
            let status = UpdateStatus::Available { version: update.version.clone(), notes: update.body.clone().filter(|b| !b.trim().is_empty()) };
            *app.state::<Updater>().pending.lock().await = Some(update);
            status
        }
        Ok(None) => {
            *app.state::<Updater>().pending.lock().await = None;
            UpdateStatus::Idle { checking: false }
        }
        Err(message) => {
            eprintln!("dorks: update check failed: {message}");
            set(app, if matches!(before, UpdateStatus::Idle { .. }) { UpdateStatus::Idle { checking: false } } else { before });
            return Err(message);
        }
    };
    set(app, after.clone());
    Ok(after)
}

#[cfg(not(feature = "updater"))]
pub async fn check(_app: &AppHandle) -> Result<UpdateStatus, String> {
    Ok(UpdateStatus::Unsupported)
}

/// Downloads and installs the offered update, then stops the server and relaunches into the new version. Checks first when
/// nothing is offered yet. Returns once the download fails or the app is relaunching.
#[cfg(feature = "updater")]
pub async fn install(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    let updater = app.state::<Updater>();
    if updater.installing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    // Waits for a check in flight to finish; from here to the relaunch no check can run.
    let _busy = updater.busy.lock().await;
    let result = install_locked(app).await;
    updater.installing.store(false, Ordering::SeqCst);
    result
}

/// The install itself; the caller holds `busy`. On success the app is exiting and relaunches once it is gone.
#[cfg(feature = "updater")]
async fn install_locked(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    if app.state::<Updater>().pending.lock().await.is_none() {
        check_locked(app).await?;
    }
    let Some(update) = app.state::<Updater>().pending.lock().await.take() else {
        return Err("Dorks is up to date".into());
    };
    let version = update.version.clone();
    set(app, UpdateStatus::Downloading { version: version.clone(), downloaded: 0, total: None });

    let mut downloaded: u64 = 0;
    let mut last_percent: Option<u64> = None;
    let progress_app = app.clone();
    let progress_version = version.clone();
    let done_app = app.clone();
    let done_version = version.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                // One event per percent (or per MB without a length), not one per chunk.
                let step = match total {
                    Some(t) if t > 0 => downloaded * 100 / t,
                    _ => downloaded / 1_000_000,
                };
                if last_percent != Some(step) {
                    last_percent = Some(step);
                    set(&progress_app, UpdateStatus::Downloading { version: progress_version.clone(), downloaded, total });
                }
            },
            move || set(&done_app, UpdateStatus::Installing { version: done_version.clone() }),
        )
        .await;

    if let Err(e) = result {
        let message = e.to_string();
        eprintln!("dorks: update to {version} failed: {message}");
        // Offer it again: put the update back so "Try again" does not need a new check.
        *app.state::<Updater>().pending.lock().await = Some(update);
        set(app, UpdateStatus::Failed { version, message: message.clone() });
        return Err(message);
    }

    eprintln!("dorks: installed {version}, relaunching");
    let state = app.state::<crate::state::AppState>();
    state.quitting.store(true, Ordering::SeqCst);
    crate::window::flush(app);
    crate::boot::stop_runtime(app).await;
    state.shutdown_done.store(true, Ordering::SeqCst);
    relaunch(app);
    Ok(())
}

/// Starts the new version once this process is gone, then exits.
///
/// Not `app.restart()`: on macOS that runs `open -n Dorks.app` while this process is still alive, so the Dock gives the
/// new instance a tile of its own next to the pinned one, and the user is left with two Dorks icons. A detached shell
/// waits for this pid to exit (30 s at most) and then opens the bundle normally, so it lands in the usual tile.
#[cfg(all(feature = "updater", target_os = "macos"))]
fn relaunch(app: &AppHandle) {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    const OPEN_WHEN_GONE: &str =
        "i=0; while kill -0 \"$1\" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done; exec /usr/bin/open \"$2\"";

    // `…/Dorks.app/Contents/MacOS/dorks` → `…/Dorks.app`
    let bundle = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|exe| exe.ancestors().nth(3).map(std::path::Path::to_path_buf))
        .filter(|path| path.extension().is_some_and(|ext| ext == "app"));
    let Some(bundle) = bundle else {
        app.restart();
    };
    let spawned = Command::new("/bin/sh")
        .arg("-c")
        .arg(OPEN_WHEN_GONE)
        .arg("sh")
        .arg(std::process::id().to_string())
        .arg(&bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
    if let Err(e) = spawned {
        eprintln!("dorks: could not schedule the relaunch ({e}), restarting directly");
        app.restart();
    }
    app.exit(0);
}

#[cfg(all(feature = "updater", not(target_os = "macos")))]
fn relaunch(app: &AppHandle) {
    app.restart();
}

#[cfg(not(feature = "updater"))]
pub async fn install(_app: &AppHandle) -> Result<(), String> {
    Err("updates are not enabled in this build".into())
}
