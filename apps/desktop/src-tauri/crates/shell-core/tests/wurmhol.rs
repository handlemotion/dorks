//! The wurmhol provider against fake `wurmhol` clients (shell scripts written by the test): a detaching one like today's CLI, a
//! foreground one like the proposed mode, and failures. Checks the token travels by environment only and that only the port is
//! passed.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use dorks_shell_core::tunnel::{Tunnel, TunnelError, TunnelHealth, TunnelTarget};
use dorks_shell_core::wurmhol::{WurmholConfig, WurmholTunnel};

const TOKEN: &str = "wh_test_token_value";
const URL_LINE: &str = r#"{"url":"https://abcde12345.pipe.wurmhol.com","port":4748,"id":"abcde12345"}"#;

fn script(dir: &Path, body: &str) -> PathBuf {
    let path = dir.join("wurmhol");
    std::fs::write(&path, format!("#!/bin/sh\nSTATE=\"{}\"\n{body}\n", dir.display())).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn config(dir: &Path, bin: PathBuf) -> WurmholConfig {
    let mut cfg = WurmholConfig::new(bin, dir.join("wurmhol.log"));
    cfg.token = Some(TOKEN.into());
    cfg.start_timeout = Duration::from_secs(5);
    cfg.poll_interval = Duration::from_millis(100);
    cfg.stop_grace = Duration::from_secs(2);
    cfg
}

/// Like today's CLI: `<port> --json` records its arguments and token, prints the URL and exits; a daemon is simulated by the
/// `pipe` file. `ls --json` lists it while it exists; `stop <id>` removes it.
fn detaching(dir: &Path) -> PathBuf {
    script(
        dir,
        &format!(
            r#"case "$1" in
  ls) if [ -f "$STATE/pipe" ]; then echo '[{{"id":"abcde12345"}}]'; else echo '[]'; fi ;;
  stop) echo "$2" > "$STATE/stopped"; rm -f "$STATE/pipe" ;;
  *) printf '%s ' "$@" > "$STATE/args"; printf '%s' "$WURMHOL_TOKEN" > "$STATE/token"; printf '%s' "$WURMHOL_URL" > "$STATE/server"
     touch "$STATE/pipe"; echo '{URL_LINE}' ;;
esac"#
        ),
    )
}

fn foreground(dir: &Path) -> PathBuf {
    script(
        dir,
        &format!(
            r#"echo $$ > "$STATE/pid"
echo '{URL_LINE}'
trap 'touch "$STATE/terminated"; exit 0' TERM
while true; do sleep 0.1; done"#
        ),
    )
}

fn target() -> TunnelTarget {
    TunnelTarget { bridge_port: 4748 }
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    for _ in 0..100 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn without_a_token_it_says_where_to_get_one() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path(), detaching(dir.path()));
    cfg.token = None;
    let err = WurmholTunnel::new(cfg).start(target()).await.unwrap_err();
    assert!(matches!(&err, TunnelError::Failed(m) if m.contains("no wurmhol token") && m.contains("Settings")), "{err}");
}

#[tokio::test]
async fn a_missing_client_is_explained() {
    let dir = tempfile::tempdir().unwrap();
    let err = WurmholTunnel::new(config(dir.path(), dir.path().join("nope"))).start(target()).await.unwrap_err();
    assert!(matches!(&err, TunnelError::Failed(m) if m.contains("cannot run") && m.contains("WURMHOL_BIN")), "{err}");
}

#[tokio::test]
async fn detaching_client_gives_the_url_and_gets_only_the_port_and_the_token_by_env() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path(), detaching(dir.path()));
    cfg.server = Some("https://relay.example.com".into());
    cfg.extra_args = vec!["--name".into(), "mine".into()];
    let tunnel = WurmholTunnel::new(cfg);
    let endpoint = tunnel.start(target()).await.unwrap();
    assert_eq!(endpoint.public_url, "https://abcde12345.pipe.wurmhol.com");

    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    assert_eq!(args.trim(), "4748 --json --name mine", "only the bridge port is exposed; the UI port never appears");
    assert!(!args.contains(TOKEN), "the token must not be an argument");
    assert_eq!(std::fs::read_to_string(dir.path().join("token")).unwrap(), TOKEN);
    assert_eq!(std::fs::read_to_string(dir.path().join("server")).unwrap(), "https://relay.example.com");

    tunnel.stop().await;
    assert_eq!(std::fs::read_to_string(dir.path().join("stopped")).unwrap().trim(), "abcde12345", "stop ends the pipe by id");
    assert!(!dir.path().join("pipe").exists());
    tunnel.stop().await; // safe to repeat
}

#[tokio::test]
async fn a_detached_pipe_that_ends_is_reported_once() {
    let dir = tempfile::tempdir().unwrap();
    let tunnel = WurmholTunnel::new(config(dir.path(), detaching(dir.path())));
    let mut health = tunnel.watch().unwrap();
    tunnel.start(target()).await.unwrap();
    assert_eq!(*health.borrow_and_update(), TunnelHealth::Up);

    std::fs::remove_file(dir.path().join("pipe")).unwrap(); // expired, terminated from the wall, or token revoked
    tokio::time::timeout(Duration::from_secs(5), health.changed()).await.expect("a health change").unwrap();
    assert!(matches!(&*health.borrow(), TunnelHealth::Lost(r) if r.contains("ended")));
    tunnel.stop().await;
}

#[tokio::test]
async fn foreground_client_is_supervised_and_stopped_with_sigterm() {
    let dir = tempfile::tempdir().unwrap();
    let tunnel = WurmholTunnel::new(config(dir.path(), foreground(dir.path())));
    let endpoint = tunnel.start(target()).await.unwrap();
    assert_eq!(endpoint.public_url, "https://abcde12345.pipe.wurmhol.com");
    tunnel.stop().await;
    eventually("SIGTERM to reach the client", || dir.path().join("terminated").exists()).await;
}

#[tokio::test]
async fn foreground_client_dying_is_reported_with_its_last_stderr_line() {
    let dir = tempfile::tempdir().unwrap();
    let bin = script(dir.path(), &format!("echo '{URL_LINE}'\nsleep 1.2\necho 'wurmhol: token revoked or unknown' >&2\nexit 1"));
    let tunnel = WurmholTunnel::new(config(dir.path(), bin));
    let mut health = tunnel.watch().unwrap();
    tunnel.start(target()).await.unwrap();
    assert_eq!(*health.borrow_and_update(), TunnelHealth::Up);
    tokio::time::timeout(Duration::from_secs(5), health.changed()).await.expect("a health change").unwrap();
    assert!(matches!(&*health.borrow(), TunnelHealth::Lost(r) if r.contains("token revoked or unknown")), "{:?}", *health.borrow());
    assert!(std::fs::read_to_string(dir.path().join("wurmhol.log")).unwrap().contains("token revoked"));
}

#[tokio::test]
async fn a_client_that_fails_before_opening_a_pipe_returns_its_message() {
    let dir = tempfile::tempdir().unwrap();
    let bin = script(dir.path(), "echo 'wurmhol: no subscription' >&2\nexit 1");
    let err = WurmholTunnel::new(config(dir.path(), bin)).start(target()).await.unwrap_err();
    assert_eq!(err, TunnelError::Failed("no subscription".into()));
}

#[tokio::test]
async fn garbage_output_is_rejected_and_the_client_is_not_left_running() {
    let dir = tempfile::tempdir().unwrap();
    let bin = script(dir.path(), "echo 'https://plain.example.com'\nsleep 30");
    let err = WurmholTunnel::new(config(dir.path(), bin)).start(target()).await.unwrap_err();
    assert!(matches!(&err, TunnelError::Failed(m) if m.contains("unexpected output")), "{err}");
}

#[tokio::test]
async fn a_client_that_never_answers_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let bin = script(dir.path(), "sleep 30");
    let mut cfg = config(dir.path(), bin);
    cfg.start_timeout = Duration::from_millis(300);
    let err = WurmholTunnel::new(cfg).start(target()).await.unwrap_err();
    assert!(matches!(&err, TunnelError::Failed(m) if m.contains("did not open a pipe")), "{err}");
}
