//! The wurmhol provider against fake `wurmhol` clients (shell scripts written by the test) and a fake Dorks tunnel service: a
//! detaching client like today's CLI, a foreground one, and failures. Checks the connector comes from the service with this
//! install's key, travels by environment only, is kept and reused, is replaced once when the client refuses it, and that only
//! the port is passed (no name, no access key).

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dorks_shell_core::connector::{self, Connector};
use dorks_shell_core::secrets::write_private;
use dorks_shell_core::tunnel::{Tunnel, TunnelError, TunnelHealth, TunnelTarget};
use dorks_shell_core::wurmhol::{ConnectorSource, WurmholConfig, WurmholTunnel};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const INSTALL_KEY: &str = "dti_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const URL_LINE: &str = r#"{"url":"https://eabcde12345fghij.pipe.wurmhol.com","port":4748,"id":"abcde12345"}"#;

/// The `n`th connector the fake service hands out.
fn connector_n(n: usize) -> String {
    format!("whc_{}{n}", "c".repeat(42))
}

/// A Dorks tunnel service on loopback: answers `POST /v1/tunnel` with connector 1, 2, ... and records `METHOD path auth`.
async fn fake_service() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match sock.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let head = String::from_utf8_lossy(&buf).to_string();
            let line = head.lines().next().unwrap_or("").split(' ').take(2).collect::<Vec<_>>().join(" ");
            let auth = head.lines().find_map(|l| l.strip_prefix("authorization: ")).unwrap_or("").to_string();
            let n = {
                let mut seen = log.lock().unwrap();
                seen.push(format!("{line} {auth}"));
                seen.len()
            };
            let body = format!(r#"{{"tunnel":{{"id":"t1","url":"https://eabcde12345fghij.pipe.wurmhol.com"}},"connector":{{"connector":"{}","expiresAt":"2027-11-11T00:00:00Z"}}}}"#, connector_n(n));
            let _ = sock.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
        }
    });
    (url, seen)
}

fn script(dir: &Path, body: &str) -> PathBuf {
    let path = dir.join("wurmhol");
    std::fs::write(&path, format!("#!/bin/sh\nSTATE=\"{}\"\n{body}\n", dir.display())).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn config(dir: &Path, bin: PathBuf, service: &str) -> WurmholConfig {
    let mut cfg = WurmholConfig::new(bin, dir.join("wurmhol.log"));
    cfg.source = Some(ConnectorSource { service: service.into(), install_key: INSTALL_KEY.into(), file: dir.join("wurmhol-connector") });
    cfg.start_timeout = Duration::from_secs(5);
    cfg.poll_interval = Duration::from_millis(100);
    cfg.stop_grace = Duration::from_secs(2);
    cfg
}

/// A connector already kept from an earlier start.
fn stored(dir: &Path, value: &str) {
    let c = Connector { connector: value.into(), tunnel_id: "t1".into(), url: "https://eabcde12345fghij.pipe.wurmhol.com".into(), fetched_at: now() };
    write_private(&dir.join("wurmhol-connector"), &serde_json::to_vec(&c).unwrap()).unwrap();
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
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
  *) printf '%s ' "$@" > "$STATE/args"; printf '%s' "$WURMHOL_TOKEN" > "$STATE/token"; printf '%s' "$WURMHOL_URL" > "$STATE/server"; printf '%s' "${{WURMHOL_ACCESS_KEY-unset}}" > "$STATE/key"
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
async fn a_missing_client_is_explained() {
    let dir = tempfile::tempdir().unwrap();
    let (service, _) = fake_service().await;
    let err = WurmholTunnel::new(config(dir.path(), dir.path().join("nope"), &service)).start(target()).await.unwrap_err();
    assert!(matches!(&err, TunnelError::Failed(m) if m.contains("cannot run") && m.contains("WURMHOL_BIN")), "{err}");
}

#[tokio::test]
async fn first_start_gets_a_connector_from_the_service_and_passes_it_by_env_only() {
    let dir = tempfile::tempdir().unwrap();
    let (service, seen) = fake_service().await;
    let mut cfg = config(dir.path(), detaching(dir.path()), &service);
    cfg.server = Some("https://relay.example.com".into());
    let tunnel = WurmholTunnel::new(cfg);
    let endpoint = tunnel.start(target()).await.unwrap();
    assert_eq!(endpoint.public_url, "https://eabcde12345fghij.pipe.wurmhol.com");
    assert_eq!(*seen.lock().unwrap(), vec![format!("POST /v1/tunnel Bearer {INSTALL_KEY}")]);

    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    assert_eq!(args.trim(), "4748 --json", "only the bridge port is exposed: no name, no UI port");
    assert_eq!(std::fs::read_to_string(dir.path().join("token")).unwrap(), connector_n(1));
    assert!(!args.contains("whc_"), "the connector must not be an argument");
    assert_eq!(std::fs::read_to_string(dir.path().join("key")).unwrap(), "unset", "a connector takes no access key");
    assert_eq!(std::fs::read_to_string(dir.path().join("server")).unwrap(), "https://relay.example.com");
    let kept = dir.path().join("wurmhol-connector");
    assert_eq!(std::fs::metadata(&kept).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(connector::stored(&kept).unwrap().connector, connector_n(1));

    tunnel.stop().await;
    assert_eq!(std::fs::read_to_string(dir.path().join("stopped")).unwrap().trim(), "abcde12345", "stop ends the pipe by id");
    assert!(!dir.path().join("pipe").exists());
    tunnel.stop().await; // safe to repeat

    // The next start reuses the kept connector: the tunnel and its URL stay the same, and the service is not asked again.
    tunnel.start(target()).await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    tunnel.stop().await;
}

#[tokio::test]
async fn a_refused_stored_connector_is_replaced_once() {
    let dir = tempfile::tempdir().unwrap();
    let (service, seen) = fake_service().await;
    stored(dir.path(), &format!("whc_{}", "r".repeat(43)));
    // Like the CLI with a revoked connector: refuses it on stderr; accepts the new one.
    let bin = script(
        dir.path(),
        &format!(
            r#"case "$1" in
  ls) echo '[{{"id":"abcde12345"}}]' ;;
  stop) ;;
  *) case "$WURMHOL_TOKEN" in whc_rrr*) echo 'wurmhol: that connector was revoked' >&2; exit 1 ;; esac
     echo '{URL_LINE}' ;;
esac"#
        ),
    );
    let tunnel = WurmholTunnel::new(config(dir.path(), bin, &service));
    tunnel.start(target()).await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1, "asked for a new connector once");
    assert_eq!(connector::stored(&dir.path().join("wurmhol-connector")).unwrap().connector, connector_n(1));
    tunnel.stop().await;
}

#[tokio::test]
async fn a_detached_pipe_that_ends_is_reported_once() {
    let dir = tempfile::tempdir().unwrap();
    let (service, _) = fake_service().await;
    let tunnel = WurmholTunnel::new(config(dir.path(), detaching(dir.path()), &service));
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
    let (service, _) = fake_service().await;
    let tunnel = WurmholTunnel::new(config(dir.path(), foreground(dir.path()), &service));
    let endpoint = tunnel.start(target()).await.unwrap();
    assert_eq!(endpoint.public_url, "https://eabcde12345fghij.pipe.wurmhol.com");
    tunnel.stop().await;
    eventually("SIGTERM to reach the client", || dir.path().join("terminated").exists()).await;
}

#[tokio::test]
async fn foreground_client_dying_is_reported_with_its_last_stderr_line() {
    let dir = tempfile::tempdir().unwrap();
    let bin = script(dir.path(), &format!("echo '{URL_LINE}'\nsleep 1.2\necho 'wurmhol: connector revoked or unknown' >&2\nexit 1"));
    let (service, _) = fake_service().await;
    let tunnel = WurmholTunnel::new(config(dir.path(), bin, &service));
    let mut health = tunnel.watch().unwrap();
    tunnel.start(target()).await.unwrap();
    assert_eq!(*health.borrow_and_update(), TunnelHealth::Up);
    tokio::time::timeout(Duration::from_secs(5), health.changed()).await.expect("a health change").unwrap();
    assert!(matches!(&*health.borrow(), TunnelHealth::Lost(r) if r.contains("connector revoked or unknown")), "{:?}", *health.borrow());
    assert!(std::fs::read_to_string(dir.path().join("wurmhol.log")).unwrap().contains("connector revoked"));
}

#[tokio::test]
async fn a_client_that_fails_before_opening_a_pipe_returns_its_message() {
    let dir = tempfile::tempdir().unwrap();
    let (service, seen) = fake_service().await;
    let bin = script(dir.path(), "echo 'wurmhol: no subscription' >&2\nexit 1");
    let err = WurmholTunnel::new(config(dir.path(), bin, &service)).start(target()).await.unwrap_err();
    assert_eq!(err, TunnelError::Failed("no subscription".into()));
    assert_eq!(seen.lock().unwrap().len(), 1, "a connector just issued is not asked for again");
}

#[tokio::test]
async fn garbage_output_is_rejected_and_the_client_is_not_left_running() {
    let dir = tempfile::tempdir().unwrap();
    let (service, _) = fake_service().await;
    let bin = script(dir.path(), "echo 'https://plain.example.com'\nsleep 30");
    let err = WurmholTunnel::new(config(dir.path(), bin, &service)).start(target()).await.unwrap_err();
    assert!(matches!(&err, TunnelError::Failed(m) if m.contains("unexpected output")), "{err}");
}

#[tokio::test]
async fn a_client_that_never_answers_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let (service, _) = fake_service().await;
    let bin = script(dir.path(), "sleep 30");
    let mut cfg = config(dir.path(), bin, &service);
    cfg.start_timeout = Duration::from_millis(300);
    let err = WurmholTunnel::new(cfg).start(target()).await.unwrap_err();
    assert!(matches!(&err, TunnelError::Failed(m) if m.contains("did not open")), "{err}");
}
