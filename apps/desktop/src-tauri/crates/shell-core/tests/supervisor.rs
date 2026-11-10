//! Supervision against the stub sidecar: start, health, token plumbing, crash and sickness restarts, give-up, stale reaping.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::Duration;

use dorks_shell_core::health::http_status;
use dorks_shell_core::ports::pick_port;
use dorks_shell_core::supervisor::{reap_stale, Policy, SidecarSpec, Status, Supervisor};

const STUB: &str = env!("CARGO_BIN_EXE_dorks-server-stub");
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct Rig {
    dir: tempfile::TempDir,
    ui: u16,
    bridge: u16,
}

impl Rig {
    fn new() -> Rig {
        let ui = pick_port(None, &[]).unwrap();
        let bridge = pick_port(None, &[ui]).unwrap();
        Rig { dir: tempfile::tempdir().unwrap(), ui, bridge }
    }

    fn spec(&self, extra: &[(&str, &str)]) -> SidecarSpec {
        let data = self.dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let mut env = vec![
            ("DORKS_DATA_DIR".to_string(), data.display().to_string()),
            ("DORKS_OWNER_TOKEN".to_string(), TOKEN.to_string()),
            ("DORKS_UI_PORT".to_string(), self.ui.to_string()),
            ("DORKS_BRIDGE_PORT".to_string(), self.bridge.to_string()),
            ("DORKS_PUBLIC_URL".to_string(), "https://me.example.com".to_string()),
            ("DORKS_PARENT_PID".to_string(), std::process::id().to_string()),
        ];
        env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        SidecarSpec {
            program: STUB.into(),
            args: Vec::<OsString>::new(),
            env,
            log_file: self.dir.path().join("logs").join("server.log"),
            pid_file: Some(self.dir.path().join("server.pid")),
            health_port: self.ui,
            health_path: "/api/health".into(),
        }
    }
}

fn fast() -> Policy {
    Policy {
        startup_timeout: Duration::from_secs(10),
        startup_poll: Duration::from_millis(50),
        health_interval: Duration::from_millis(100),
        health_timeout: Duration::from_millis(500),
        health_failures: 2,
        backoff_initial: Duration::from_millis(50),
        backoff_max: Duration::from_millis(200),
        max_failures: 3,
        failure_window: Duration::from_secs(30),
        stable_after: Duration::from_secs(30),
        stop_grace: Duration::from_secs(3),
        max_log_bytes: 1024 * 1024,
    }
}

fn get(port: u16, path: &str, bearer: Option<&str>) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let auth = bearer.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: x\r\n{auth}Connection: close\r\n\r\n").unwrap();
    let mut raw = String::new();
    let _ = stream.read_to_string(&mut raw);
    let status = raw.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    (status, raw.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
}

const LONG: Duration = Duration::from_secs(15);

#[tokio::test]
async fn runs_the_server_with_the_contract_and_stops_it_gracefully() {
    let rig = Rig::new();
    let sup = Supervisor::start(rig.spec(&[]), fast());
    assert!(sup.wait_for(|s| *s == Status::Running, LONG).await, "status: {:?}", sup.status());

    // token plumbing: the owner token reached the server, wrong or missing tokens are refused
    assert_eq!(get(rig.ui, "/api/ping", Some(TOKEN)).0, 200);
    assert_eq!(get(rig.ui, "/api/ping", Some("wrong")).0, 401);
    assert_eq!(get(rig.ui, "/api/ping", None).0, 401);
    // the bridge port is up, the public URL and parent pid arrived, data dir is writable
    assert_eq!(get(rig.bridge, "/", None).0, 200);
    let (_, env) = get(rig.ui, "/env", None);
    assert!(env.contains("\"publicUrlSet\":true") && env.contains("\"parentPidSet\":true"), "{env}");
    assert!(rig.dir.path().join("data").join("stub.db").exists());
    assert!(rig.dir.path().join("server.pid").exists());

    sup.shutdown().await;
    assert_eq!(sup.status(), Status::Stopped);
    assert!(http_status(rig.ui, "/api/health", Duration::from_millis(300)).await.is_err(), "port must be closed");
    assert!(!rig.dir.path().join("server.pid").exists());
    let log = std::fs::read_to_string(rig.dir.path().join("logs").join("server.log")).unwrap();
    assert!(log.contains("listening"), "{log}");
    assert!(log.contains("terminated cleanly"), "SIGTERM must reach the server and let it exit: {log}");
    assert!(!log.contains(TOKEN), "the owner token must not appear in the log");
}

#[tokio::test]
async fn restarts_after_a_crash() {
    let rig = Rig::new();
    let sup = Supervisor::start(rig.spec(&[]), fast());
    assert!(sup.wait_for(|s| *s == Status::Running, LONG).await);
    let first = std::fs::read_to_string(rig.dir.path().join("server.pid")).unwrap();
    let _ = get_ignoring_reset(rig.ui, "/crash");
    // the status may pass through Restarting too quickly to observe; a different pid proves a new process
    let deadline = std::time::Instant::now() + LONG;
    loop {
        let now = std::fs::read_to_string(rig.dir.path().join("server.pid")).unwrap_or_default();
        if !now.is_empty() && now != first && sup.status() == Status::Running {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "no restart; status: {:?}", sup.status());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(get(rig.ui, "/api/ping", Some(TOKEN)).0, 200);
    sup.shutdown().await;
}

#[tokio::test]
async fn restarts_a_server_that_stops_answering_health_checks() {
    let rig = Rig::new();
    let sup = Supervisor::start(rig.spec(&[]), fast());
    assert!(sup.wait_for(|s| *s == Status::Running, LONG).await);
    assert_eq!(get(rig.ui, "/sick", None).0, 200);
    assert_eq!(get(rig.ui, "/api/health", None).0, 503);
    assert!(
        sup.wait_for(|s| matches!(s, Status::Restarting { reason, .. } if reason.contains("health")), LONG).await,
        "status: {:?}",
        sup.status()
    );
    assert!(sup.wait_for(|s| *s == Status::Running, LONG).await);
    assert_eq!(get(rig.ui, "/api/health", None).0, 200, "a fresh process is healthy again");
    sup.shutdown().await;
}

#[tokio::test]
async fn waits_for_a_slow_start_and_gives_up_on_a_stuck_one() {
    let rig = Rig::new();
    let sup = Supervisor::start(rig.spec(&[("STUB_STARTUP_DELAY_MS", "700")]), fast());
    assert_eq!(sup.status(), Status::Starting);
    assert!(sup.wait_for(|s| *s == Status::Running, LONG).await);
    sup.shutdown().await;

    let rig = Rig::new();
    let policy = Policy { startup_timeout: Duration::from_millis(400), ..fast() };
    let sup = Supervisor::start(rig.spec(&[("STUB_STARTUP_DELAY_MS", "30000")]), policy);
    assert!(sup.wait_for(|s| matches!(s, Status::Restarting { reason, .. } if reason.contains("did not answer")), LONG).await, "{:?}", sup.status());
    sup.shutdown().await;
}

#[tokio::test]
async fn gives_up_on_a_crash_loop_until_asked_to_restart() {
    let rig = Rig::new();
    let sup = Supervisor::start(rig.spec(&[("STUB_EXIT_CODE", "3")]), fast());
    assert!(sup.wait_for(|s| matches!(s, Status::Failed { .. }), LONG).await, "status: {:?}", sup.status());
    let Status::Failed { reason } = sup.status() else { unreachable!() };
    assert!(reason.contains("exited"), "{reason}");
    // restart() leaves Failed and tries again (and fails again, since the stub still exits)
    sup.restart();
    assert!(sup.wait_for(|s| matches!(s, Status::Starting | Status::Restarting { .. }), LONG).await);
    assert!(sup.wait_for(|s| matches!(s, Status::Failed { .. }), LONG).await);
    sup.shutdown().await;
    assert_eq!(sup.status(), Status::Stopped);
}

#[tokio::test]
async fn a_missing_binary_is_a_failure_not_a_panic() {
    let rig = Rig::new();
    let mut spec = rig.spec(&[]);
    spec.program = rig.dir.path().join("does-not-exist");
    let sup = Supervisor::start(spec, fast());
    assert!(sup.wait_for(|s| matches!(s, Status::Failed { reason } if reason.contains("could not start")), LONG).await, "{:?}", sup.status());
    sup.shutdown().await;
}

#[tokio::test]
async fn manual_restart_gives_a_new_process() {
    let rig = Rig::new();
    let sup = Supervisor::start(rig.spec(&[]), fast());
    assert!(sup.wait_for(|s| *s == Status::Running, LONG).await);
    let first = std::fs::read_to_string(rig.dir.path().join("server.pid")).unwrap();
    sup.restart();
    assert!(sup.wait_for(|s| *s == Status::Starting, LONG).await);
    assert!(sup.wait_for(|s| *s == Status::Running, LONG).await);
    let second = std::fs::read_to_string(rig.dir.path().join("server.pid")).unwrap();
    assert_ne!(first, second);
    sup.shutdown().await;
}

#[test]
fn reaps_an_orphaned_server_but_not_an_unrelated_process() {
    let rig = Rig::new();
    let spec = rig.spec(&[]);
    let mut orphan = Command::new(STUB);
    orphan.env_clear().envs(spec.env.iter().map(|(k, v)| (k, v))).stdout(Stdio::null()).stderr(Stdio::null());
    let mut orphan = orphan.spawn().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let pid_file = rig.dir.path().join("stale.pid");
    std::fs::write(&pid_file, orphan.id().to_string()).unwrap();
    assert_eq!(reap_stale(&pid_file, "dorks-server", Duration::from_secs(3)), Some(orphan.id()));
    assert!(orphan.wait().is_ok(), "the orphan is gone");
    assert!(!pid_file.exists());

    let mut bystander = Command::new("sleep").arg("30").spawn().unwrap();
    std::fs::write(&pid_file, bystander.id().to_string()).unwrap();
    assert_eq!(reap_stale(&pid_file, "dorks-server", Duration::from_secs(1)), None);
    assert!(bystander.try_wait().unwrap().is_none(), "a process with another name must be left alone");
    bystander.kill().unwrap();
    let _ = bystander.wait();

    assert_eq!(reap_stale(&rig.dir.path().join("none.pid"), "dorks-server", Duration::from_secs(1)), None);
}

#[test]
fn the_server_exits_when_the_shell_is_gone() {
    let rig = Rig::new();
    let mut parent = Command::new("sleep").arg("1").spawn().unwrap();
    let spec = rig.spec(&[("DORKS_PARENT_PID", &parent.id().to_string())]);
    let mut child = Command::new(STUB);
    child.env_clear().envs(spec.env.iter().map(|(k, v)| (k, v))).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = child.spawn().unwrap();
    let _ = parent.wait();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "the server kept running without its parent");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// `/crash` kills the connection without a response.
fn get_ignoring_reset(port: u16, path: &str) -> Option<u16> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    write!(stream, "GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").ok()?;
    let mut raw = String::new();
    let _ = stream.read_to_string(&mut raw);
    raw.split_whitespace().nth(1).and_then(|s| s.parse().ok())
}

