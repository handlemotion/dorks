//! Secrets the shell generates: the owner token. Stored in a 0600 file; never logged.

use std::io::{self, Write};
use std::path::Path;

/// 32 random bytes as 64 hex characters.
pub fn generate_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// True for a token this module could have generated.
pub fn is_valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Reads the owner token, creating it (mode 0600) on first run. A file with a malformed token is an error rather than
/// being silently replaced, since replacing it would lock the user out of data they may still want.
pub fn ensure_owner_token(path: &Path) -> io::Result<String> {
    match std::fs::read_to_string(path) {
        Ok(existing) => {
            let token = existing.trim().to_string();
            if !is_valid_token(&token) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{} does not contain a valid owner token; delete it to create a new one", path.display()),
                ));
            }
            restrict(path)?;
            Ok(token)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let token = generate_token()?;
            write_private(path, token.as_bytes())?;
            Ok(token)
        }
        Err(e) => Err(e),
    }
}

/// A secret stored as a 0600 file: trimmed contents, or `None` when the file is missing or blank.
pub fn read_secret(path: &Path) -> io::Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            restrict(path)?;
            let text = text.trim();
            Ok((!text.is_empty()).then(|| text.to_string()))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Stores a secret (mode 0600), or removes the file when `value` is `None`.
pub fn write_secret(path: &Path, value: Option<&str>) -> io::Result<()> {
    match value {
        Some(v) => write_private(path, v.trim().as_bytes()),
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    }
}

/// Writes `bytes` to `path` atomically (temp file + rename) with mode 0600.
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = open_private(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(unix)]
fn open_private(path: &Path) -> io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)
}

#[cfg(not(unix))]
fn open_private(path: &Path) -> io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)
}

#[cfg(unix)]
fn restrict(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path)?.permissions().mode() & 0o777;
    if mode != 0o600 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_once_and_reuses() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("owner-token");
        let first = ensure_owner_token(&path).unwrap();
        assert_eq!(ensure_owner_token(&path).unwrap(), first);
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), first);
    }

    #[cfg(unix)]
    #[test]
    fn file_is_private_and_loose_modes_are_tightened() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("owner-token");
        ensure_owner_token(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        ensure_owner_token(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn secrets_round_trip_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wurmhol-token");
        assert_eq!(read_secret(&path).unwrap(), None);
        write_secret(&path, Some("  wh_abc \n")).unwrap();
        assert_eq!(read_secret(&path).unwrap().as_deref(), Some("wh_abc"));
        write_secret(&path, None).unwrap();
        assert_eq!(read_secret(&path).unwrap(), None);
        write_secret(&path, None).unwrap();
        std::fs::write(&path, " \n").unwrap();
        assert_eq!(read_secret(&path).unwrap(), None);
    }

    #[test]
    fn malformed_token_is_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("owner-token");
        std::fs::write(&path, "not a token").unwrap();
        assert!(ensure_owner_token(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a token");
    }
}
