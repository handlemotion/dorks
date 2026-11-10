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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// User-supplied public URL of the bridge port (own domain, reverse proxy, other tunnel). Overrides wurmhol.
    pub public_url: Option<String>,
    /// Last ports used, tried first on the next start so URLs stay stable.
    pub ui_port: Option<u16>,
    pub bridge_port: Option<u16>,
    pub keep_awake: KeepAwake,
    /// A self-hosted wurmhol install (`WURMHOL_URL`); unset means the hosted one.
    pub wurmhol_server: Option<String>,
    /// Extra arguments for the wurmhol client, after `<port> --json` (for flags the relay learns later, such as a reserved
    /// name). The token never goes here; it has its own 0600 file.
    pub wurmhol_args: Vec<String>,
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

/// A public URL must be https, or http on a loopback host (local testing). No credentials, no query, no fragment.
/// Returns it normalised without a trailing slash.
pub fn validate_public_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    let (scheme, rest) = url.split_once("://").ok_or("the URL must start with https://")?;
    if rest.is_empty() || rest.contains(char::is_whitespace) {
        return Err("the URL is not valid".into());
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    if authority.is_empty() || authority.contains('@') {
        return Err("the URL must have a host and no credentials".into());
    }
    if tail.contains(['?', '#']) {
        return Err("the URL must not have a query or fragment".into());
    }
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority).trim_matches(['[', ']']);
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    match scheme {
        "https" => {}
        "http" if loopback => {}
        "http" => return Err("use https, plain http is only allowed for localhost".into()),
        _ => return Err("the URL must start with https://".into()),
    }
    Ok(format!("{scheme}://{authority}{}", tail.trim_end_matches('/')))
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
            public_url: Some("https://x.example".into()),
            ui_port: Some(1),
            bridge_port: Some(2),
            keep_awake: KeepAwake::Always,
            wurmhol_server: Some("https://wh.example".into()),
            wurmhol_args: vec!["--name".into(), "mine".into()],
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
        std::fs::write(&path, r#"{"publicUrl":"https://a.example","somethingNew":1}"#).unwrap();
        let s = Settings::load(&path).unwrap();
        assert_eq!(s.public_url.as_deref(), Some("https://a.example"));
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

    #[test]
    fn public_url_validation() {
        assert_eq!(validate_public_url(" https://me.example.com/ ").unwrap(), "https://me.example.com");
        assert_eq!(validate_public_url("https://me.example.com:8443/bridge/").unwrap(), "https://me.example.com:8443/bridge");
        assert_eq!(validate_public_url("http://localhost:9000").unwrap(), "http://localhost:9000");
        assert!(validate_public_url("http://me.example.com").is_err());
        assert!(validate_public_url("me.example.com").is_err());
        assert!(validate_public_url("ftp://me.example.com").is_err());
        assert!(validate_public_url("https://user:pw@me.example.com").is_err());
        assert!(validate_public_url("https://me.example.com/?a=1").is_err());
        assert!(validate_public_url("https://").is_err());
        assert!(validate_public_url("https://a b.example").is_err());
    }
}
