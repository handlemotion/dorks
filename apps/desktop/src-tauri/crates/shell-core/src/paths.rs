//! Where the shell keeps its files.

use std::path::{Path, PathBuf};

use crate::contract::ENV_APP_DIR;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// `$DORKS_APP_DIR`, else `~/Library/Application Support/Dorks` (macOS) or `$XDG_DATA_HOME/Dorks` elsewhere.
    pub fn from_env() -> Self {
        Self::resolve(
            std::env::var_os(ENV_APP_DIR).map(PathBuf::from),
            std::env::var_os("HOME").map(PathBuf::from),
            std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
        )
    }

    pub fn resolve(app_dir: Option<PathBuf>, home: Option<PathBuf>, xdg_data: Option<PathBuf>) -> Self {
        if let Some(dir) = app_dir.filter(|d| !d.as_os_str().is_empty()) {
            return Self::new(dir);
        }
        let home = home.unwrap_or_else(|| PathBuf::from("."));
        if cfg!(target_os = "macos") {
            Self::new(home.join("Library").join("Application Support").join("Dorks"))
        } else {
            Self::new(xdg_data.unwrap_or_else(|| home.join(".local").join("share")).join("Dorks"))
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Handed to the server as `DORKS_DATA_DIR`.
    pub fn server_data_dir(&self) -> PathBuf {
        self.root.join("server")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn server_log(&self) -> PathBuf {
        self.logs_dir().join("server.log")
    }

    pub fn settings_file(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    pub fn owner_token_file(&self) -> PathBuf {
        self.root.join("owner-token")
    }

    /// This install's key for the Dorks tunnel service (0600), made once. Its wurmhol tenant, and so its tunnel and URL, follow
    /// from it.
    pub fn tunnel_install_key_file(&self) -> PathBuf {
        self.root.join("tunnel-install-key")
    }

    /// The tunnel's connector from the tunnel service (0600, JSON): what the wurmhol client opens this install's tunnel with.
    pub fn wurmhol_connector_file(&self) -> PathBuf {
        self.root.join("wurmhol-connector")
    }

    /// Files of the access-key pipe that embedded tunnels replaced (a personal token, the pipe's access key and name). The shell
    /// deletes them at start.
    pub fn legacy_wurmhol_files(&self) -> [PathBuf; 3] {
        ["wurmhol-token", "wurmhol-access-key", "wurmhol-name"].map(|f| self.root.join(f))
    }

    pub fn wurmhol_log(&self) -> PathBuf {
        self.logs_dir().join("wurmhol.log")
    }

    pub fn server_pid_file(&self) -> PathBuf {
        self.root.join("server.pid")
    }

    /// Creates the directories with mode 0700 (the data holds secrets and the database).
    pub fn ensure(&self) -> std::io::Result<()> {
        for dir in [self.root.clone(), self.server_data_dir(), self.logs_dir()] {
            std::fs::create_dir_all(&dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn ensure_creates_private_dirs() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let p = Paths::new(tmp.path().join("app"));
        p.ensure().unwrap();
        for d in [p.root().to_path_buf(), p.server_data_dir(), p.logs_dir()] {
            assert_eq!(std::fs::metadata(d).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }
}
