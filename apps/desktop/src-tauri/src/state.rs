//! Shared application state and the config handed to the UI.

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use dorks_shell_core::paths::Paths;
use dorks_shell_core::power::KeepAwake;
use dorks_shell_core::settings::Settings;
use dorks_shell_core::supervisor::{Status, Supervisor};
use dorks_shell_core::tunnel::Tunnel;
use dorks_shell_core::window::{ChromeInfo, Effect, WindowMode, WindowTheme};
use serde::Serialize;
use tauri::async_runtime::JoinHandle;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    /// `"user-url"`, `"wurmhol"`.
    pub kind: String,
    /// `"ready"`, `"approval"` (a person must approve this computer at `approvalUrl`; the shell restarts the tunnel when they
    /// have), `"error"` (could not start) or `"lost"` (it was up and went away; the shell is restarting it).
    pub state: String,
    pub error: Option<String>,
    /// Where to approve this computer, while `state` is `"approval"`.
    pub approval_url: Option<String>,
    /// Whether a wurmhol token is saved (the token itself never leaves the shell).
    pub token_set: bool,
}

/// What the UI needs to talk to the server. Contains the owner token, so it only ever goes to the app's own window.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    /// Loopback origin of the UI/API, e.g. `http://127.0.0.1:47821`.
    pub api_url: String,
    pub ui_port: u16,
    pub bridge_port: u16,
    /// Public URL of the bridge port, when a tunnel or user URL is available.
    pub public_url: Option<String>,
    pub owner_token: String,
    pub data_dir: String,
    pub version: String,
    pub tunnel: TunnelInfo,
}

/// Set on `window.__DORKS__` before any page script runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowConfig {
    #[serde(flatten)]
    pub config: Option<RuntimeConfig>,
    /// Why the server could not be started, if it could not.
    pub boot_error: Option<String>,
    /// The window chrome: mode, material, and the room to leave for the traffic lights.
    pub chrome: ChromeInfo,
}

impl WindowConfig {
    /// The `window.__DORKS__` definition, followed by the `<html>` attributes and CSS variables for the chrome.
    pub fn init_script(&self) -> String {
        let json = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        format!("Object.defineProperty(window,'__DORKS__',{{value:Object.freeze({json}),configurable:true}});{}", self.chrome.page_script())
    }
}

pub struct Runtime {
    pub supervisor: Arc<Supervisor>,
    pub tunnel: Arc<dyn Tunnel>,
    pub watcher: JoinHandle<()>,
    /// Waits for the tunnel to report it is gone (only tunnels that can be observed).
    pub tunnel_watcher: Option<JoinHandle<()>>,
}

pub struct AppState {
    pub paths: Paths,
    pub settings: Mutex<Settings>,
    pub runtime: tokio::sync::Mutex<Option<Runtime>>,
    pub config: Mutex<Option<RuntimeConfig>>,
    pub boot_error: Mutex<Option<String>>,
    pub status: Mutex<Status>,
    pub keep_awake: Mutex<KeepAwake>,
    /// The UI's statement that dorks are working (see the `set_keep_awake` command).
    pub ui_active: AtomicBool,
    /// True once the sidecar and tunnel are stopped and the app may exit.
    pub shutdown_done: AtomicBool,
    pub quitting: AtomicBool,
    /// The mode and material the main window currently has (see `window.rs`).
    pub chrome: Mutex<ChromeInfo>,
    /// Bumped on every move/resize; the debounced save only runs if it is still the latest.
    pub frame_gen: AtomicU64,
}

impl AppState {
    pub fn new(paths: Paths) -> Self {
        Self {
            paths,
            settings: Mutex::new(Settings::default()),
            runtime: tokio::sync::Mutex::new(None),
            config: Mutex::new(None),
            boot_error: Mutex::new(None),
            status: Mutex::new(Status::Starting),
            keep_awake: Mutex::new(KeepAwake::new()),
            ui_active: AtomicBool::new(false),
            shutdown_done: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            chrome: Mutex::new(ChromeInfo::new(WindowMode::default().spec(), Effect::None, WindowTheme::default())),
            frame_gen: AtomicU64::new(0),
        }
    }

    pub fn window_config(&self) -> WindowConfig {
        WindowConfig {
            config: self.config.lock().unwrap().clone(),
            boot_error: self.boot_error.lock().unwrap().clone(),
            chrome: self.chrome.lock().unwrap().clone(),
        }
    }
}
