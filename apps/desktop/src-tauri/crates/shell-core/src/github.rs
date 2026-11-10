//! Reads the user's GitHub token from their local `gh` CLI. This module only does the reading; the caller must have obtained
//! the user's explicit consent first (the desktop shell shows a native dialog), because the token goes into cloud sandboxes.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

/// Where GUI apps should look for `gh` besides PATH (a Finder-launched app has a minimal PATH).
pub const EXTRA_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

pub fn find_gh(path_var: Option<OsString>, extra: &[&str]) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_var.map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(extra.iter().map(PathBuf::from));
    dirs.into_iter().map(|d| d.join("gh")).find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &std::path::Path) -> bool {
    path.is_file()
}

/// The token from `gh auth token`'s stdout: one line, no whitespace.
pub fn parse_token(stdout: &str) -> Option<String> {
    let token = stdout.trim();
    (!token.is_empty() && !token.contains(char::is_whitespace)).then(|| token.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub logged_in: bool,
}

pub async fn status() -> GhStatus {
    let Some(gh) = find_gh(std::env::var_os("PATH"), EXTRA_DIRS) else {
        return GhStatus { installed: false, logged_in: false };
    };
    let logged_in = run(&gh, &["auth", "status"]).await.is_some_and(|out| out.status.success());
    GhStatus { installed: true, logged_in }
}

/// Runs `gh auth token`. `None` if gh is missing, not logged in, or silent. The token is never logged.
pub async fn read_token() -> Option<String> {
    let gh = find_gh(std::env::var_os("PATH"), EXTRA_DIRS)?;
    let out = run(&gh, &["auth", "token"]).await?;
    if !out.status.success() {
        return None;
    }
    parse_token(&String::from_utf8_lossy(&out.stdout))
}

async fn run(gh: &std::path::Path, args: &[&str]) -> Option<std::process::Output> {
    let child = Command::new(gh)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    timeout(Duration::from_secs(10), child.wait_with_output()).await.ok()?.ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn token_parsing() {
        assert_eq!(parse_token("gho_abc123\n").as_deref(), Some("gho_abc123"));
        assert_eq!(parse_token(""), None);
        assert_eq!(parse_token("two words"), None);
        assert_eq!(parse_token("a\nb"), None);
    }

    #[test]
    fn finds_gh_on_path_then_extra_dirs_and_skips_non_executables() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        let extra = dir.path().join("extra");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&extra).unwrap();
        std::fs::write(bin.join("gh"), "").unwrap(); // not executable
        assert_eq!(find_gh(Some(bin.clone().into_os_string()), &[]), None);
        std::fs::write(extra.join("gh"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(extra.join("gh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_gh(Some(bin.into_os_string()), &[extra.to_str().unwrap()]), Some(extra.join("gh")));
    }
}
