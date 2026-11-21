//! Shell settings, persisted as JSON next to the data. Holds no secrets.

use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::secrets::write_private;
use crate::window::{WindowFrame, WindowMode, WindowTheme};

/// When the shell holds a power assertion to keep the Mac from idle-sleeping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum KeepAwake {
    /// While the UI reports active dorks (`set_keep_awake`).
    #[default]
    WhileActive,
    /// Whenever the app runs.
    Always,
    Never,
}

/// Unknown keys are ignored, so files from older versions (with `publicUrl`, `bridgePort`, `tunnelService`, `wurmhol*`) load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Last UI port used, tried first on the next start so the URL stays stable.
    pub ui_port: Option<u16>,
    pub keep_awake: KeepAwake,
    /// The chrome the window had last (the web app sets it with `set_window_mode`). The next launch opens in it, so there is
    /// no flash of the wrong chrome. A fresh install has none and starts in onboarding.
    pub window_mode: WindowMode,
    /// The appearance the app asked for (`set_window_theme`); `system` follows macOS. Remembered so the first paint of the
    /// next launch already has the right material.
    pub window_theme: WindowTheme,
    /// Where the app-mode window was last (logical points); restored if it is still on a screen.
    pub window_frame: Option<WindowFrame>,
}

impl Settings {
    /// Missing file means defaults. A corrupt file is an error; it is not overwritten.
    pub fn load(path: &Path) -> io::Result<Settings> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("{}: {e}", path.display()))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(e),
        }
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        let mut json = serde_json::to_vec_pretty(self).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        json.push(b'\n');
        write_private(path, &json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gives_defaults_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(Settings::load(&path).unwrap(), Settings::default());
        let s = Settings {
            ui_port: Some(1),
            keep_awake: KeepAwake::Always,
            window_mode: WindowMode::App,
            window_theme: WindowTheme::Dark,
            window_frame: Some(WindowFrame { x: -5, y: 7, width: 1000, height: 700 }),
        };
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path).unwrap(), s);
    }

    #[test]
    fn unknown_and_missing_fields_are_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // Keys from the removed tunnel, plus one from the future.
        std::fs::write(&path, r#"{"publicUrl":"https://a.example","bridgePort":4748,"tunnelService":"https://t.example","wurmholServer":null,"wurmholArgs":["-v"],"uiPort":4747,"somethingNew":1}"#).unwrap();
        let s = Settings::load(&path).unwrap();
        assert_eq!(s.ui_port, Some(4747));
        assert_eq!(s.keep_awake, KeepAwake::WhileActive);
    }

    #[test]
    fn window_state_round_trips_and_old_files_start_in_onboarding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(Settings::default().window_mode, WindowMode::Onboarding);
        std::fs::write(&path, r#"{"keepAwake":"always"}"#).unwrap();
        assert_eq!(Settings::load(&path).unwrap().window_mode, WindowMode::Onboarding);

        let s = Settings { window_mode: WindowMode::App, window_theme: WindowTheme::Light, window_frame: Some(WindowFrame { x: 10, y: 20, width: 1000, height: 700 }), ..Settings::default() };
        s.save(&path).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"windowMode\": \"app\""), "{raw}");
        assert_eq!(Settings::load(&path).unwrap(), s);
    }

    #[test]
    fn corrupt_file_is_an_error_and_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{nope").unwrap();
        assert!(Settings::load(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{nope");
    }
}
