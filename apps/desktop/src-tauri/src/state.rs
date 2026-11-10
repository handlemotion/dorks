//! Shared application state and the config handed to the UI.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use dorks_shell_core::paths::Paths;
use dorks_shell_core::power::KeepAwake;
use dorks_shell_core::settings::Settings;
use dorks_shell_core::supervisor::{Status, Supervisor};
use dorks_shell_core::tunnel::Tunnel;
use serde::Serialize;
use tauri::async_runtime::JoinHandle;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    /// `"user-url"`, `"wurmhol"`.
    pub kind: String,
    /// `"ready"` or `"error"`.
    pub state: String,
    pub error: Option<String>,
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
}

impl WindowConfig {
    pub fn init_script(&self) -> String {
        let json = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        format!("Object.defineProperty(window,'__DORKS__',{{value:Object.freeze({json}),configurable:true}});")
    }
}

pub struct Runtime {
    pub supervisor: Arc<Supervisor>,
    pub tunnel: Arc<dyn Tunnel>,
    pub watcher: JoinHandle<()>,
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
        }
    }

    pub fn window_config(&self) -> WindowConfig {
        WindowConfig { config: self.config.lock().unwrap().clone(), boot_error: self.boot_error.lock().unwrap().clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> RuntimeConfig {
        RuntimeConfig {
            api_url: "http://127.0.0.1:1".into(),
            ui_port: 1,
            bridge_port: 2,
            public_url: None,
            owner_token: "t".into(),
            data_dir: "/d".into(),
            version: "0".into(),
            tunnel: TunnelInfo { kind: "wurmhol".into(), state: "error".into(), error: Some("x".into()) },
        }
    }

    #[test]
    fn init_script_defines_a_frozen_global_with_flattened_fields() {
        let script = WindowConfig { config: Some(config()), boot_error: None }.init_script();
        assert!(script.starts_with("Object.defineProperty(window,'__DORKS__'"));
        assert!(script.contains("\"apiUrl\":\"http://127.0.0.1:1\""));
        assert!(script.contains("\"ownerToken\":\"t\""));
        assert!(script.contains("\"tunnel\":{\"kind\":\"wurmhol\""));
    }

    #[test]
    fn without_a_config_only_the_error_is_exposed() {
        let script = WindowConfig { config: None, boot_error: Some("bad".into()) }.init_script();
        assert!(script.contains("\"bootError\":\"bad\""));
        assert!(!script.contains("ownerToken"));
    }
}
