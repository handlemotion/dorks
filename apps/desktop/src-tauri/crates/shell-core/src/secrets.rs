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
    fn tokens_are_64_hex_and_distinct() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert!(is_valid_token(&a));
        assert_ne!(a, b);
    }

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
    fn malformed_token_is_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("owner-token");
        std::fs::write(&path, "not a token").unwrap();
        assert!(ensure_owner_token(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a token");
    }
}
