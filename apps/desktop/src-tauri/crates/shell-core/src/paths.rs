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

    /// The user's wurmhol token (0600). Never in `settings.json`.
    pub fn wurmhol_token_file(&self) -> PathBuf {
        self.root.join("wurmhol-token")
    }

    /// The wurmhol pipe's access key (0600), made once. Sandboxes send it so the relay lets their bridge through; the per-dork
    /// HMAC remains the real authentication (docs/architecture.md).
    pub fn wurmhol_access_key_file(&self) -> PathBuf {
        self.root.join("wurmhol-access-key")
    }

    /// This install's stable pipe name (`dorks-<10 hex>`), made once so the public URL survives restarts.
    pub fn wurmhol_name_file(&self) -> PathBuf {
        self.root.join("wurmhol-name")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[cfg(unix)]
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
