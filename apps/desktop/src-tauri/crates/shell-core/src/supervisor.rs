//! Supervision of the `dorks-server` sidecar: spawn, health check, restart with backoff, graceful stop.
//!
//! One child at a time. The server's stdout and stderr go straight to a log file (no pipes, so it can never block on a full
//! pipe). When the server stays up for [`Policy::stable_after`] the failure history resets; too many failures inside
//! [`Policy::failure_window`] ends in [`Status::Failed`] until the user asks for a restart.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

use crate::health::is_healthy;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Stopped,
    Starting,
    Running,
    Restarting { attempt: u32, reason: String },
    Failed { reason: String },
}

#[derive(Debug, Clone)]
pub struct SidecarSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// Added to a minimal inherited environment ([`INHERITED_ENV`]); the rest of the shell's environment is not passed on.
    pub env: Vec<(String, String)>,
    pub log_file: PathBuf,
    /// Where the child's pid is recorded so a later run can reap an orphan (see [`reap_stale`]).
    pub pid_file: Option<PathBuf>,
    pub health_port: u16,
    pub health_path: String,
}

/// Variables copied from the shell's environment to the child.
pub const INHERITED_ENV: &[&str] = &["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"];

#[derive(Debug, Clone)]
pub struct Policy {
    pub startup_timeout: Duration,
    pub startup_poll: Duration,
    pub health_interval: Duration,
    pub health_timeout: Duration,
    /// Consecutive failed health checks (after the server was ready) before it is restarted.
    pub health_failures: u32,
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
    /// More than this many failures inside `failure_window` gives up.
    pub max_failures: u32,
    pub failure_window: Duration,
    /// Uptime after which the failure history is forgotten.
    pub stable_after: Duration,
    /// Time between SIGTERM and SIGKILL.
    pub stop_grace: Duration,
    /// The log is moved to `<log>.1` at start when larger than this.
    pub max_log_bytes: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            startup_timeout: Duration::from_secs(30),
            startup_poll: Duration::from_millis(150),
            health_interval: Duration::from_secs(5),
            health_timeout: Duration::from_secs(2),
            health_failures: 3,
            backoff_initial: Duration::from_millis(500),
            backoff_max: Duration::from_secs(15),
            max_failures: 5,
            failure_window: Duration::from_secs(120),
            stable_after: Duration::from_secs(30),
            stop_grace: Duration::from_secs(5),
            max_log_bytes: 5 * 1024 * 1024,
        }
    }
}

enum Cmd {
    Restart,
    Stop,
}

enum Exit {
    Stop,
    Restart,
    Failure(String),
}

pub struct Supervisor {
    status: watch::Receiver<Status>,
    cmd: mpsc::UnboundedSender<Cmd>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Supervisor {
    /// Starts supervising. Must be called inside a tokio runtime.
    pub fn start(spec: SidecarSpec, policy: Policy) -> Supervisor {
        let (status_tx, status) = watch::channel(Status::Starting);
        let (cmd, cmd_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(spec, policy, status_tx, cmd_rx));
        Supervisor { status, cmd, task: Mutex::new(Some(task)) }
    }

    pub fn status(&self) -> Status {
        self.status.borrow().clone()
    }

    pub fn watch(&self) -> watch::Receiver<Status> {
        self.status.clone()
    }

    /// Restarts the server now and resets the failure history (also leaves [`Status::Failed`]).
    pub fn restart(&self) {
        let _ = self.cmd.send(Cmd::Restart);
    }

    /// Waits until `pred` holds for the status, or `limit` passes.
    pub async fn wait_for(&self, pred: impl Fn(&Status) -> bool, limit: Duration) -> bool {
        let mut rx = self.status.clone();
        timeout(limit, async move {
            loop {
                if pred(&rx.borrow_and_update()) {
                    return true;
                }
                if rx.changed().await.is_err() {
                    return false;
                }
            }
        })
        .await
        .unwrap_or(false)
    }

    /// Graceful stop: SIGTERM, then SIGKILL after the grace period. Returns when the child is gone.
    pub async fn shutdown(&self) {
        let _ = self.cmd.send(Cmd::Stop);
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

async fn run(spec: SidecarSpec, policy: Policy, status: watch::Sender<Status>, mut cmd_rx: mpsc::UnboundedReceiver<Cmd>) {
    let mut failures: VecDeque<Instant> = VecDeque::new();
    let mut backoff = policy.backoff_initial;
    let mut attempt = 0u32;
    loop {
        status.send_replace(Status::Starting);
        let (exit, ready_at) = run_one(&spec, &policy, &status, &mut cmd_rx).await;
        match exit {
            Exit::Stop => {
                status.send_replace(Status::Stopped);
                return;
            }
            Exit::Restart => {
                failures.clear();
                backoff = policy.backoff_initial;
                attempt = 0;
            }
            Exit::Failure(reason) => {
                if ready_at.is_some_and(|t| t.elapsed() >= policy.stable_after) {
                    failures.clear();
                    backoff = policy.backoff_initial;
                    attempt = 0;
                }
                let now = Instant::now();
                failures.push_back(now);
                while failures.front().is_some_and(|t| now.duration_since(*t) > policy.failure_window) {
                    failures.pop_front();
                }
                if failures.len() as u32 > policy.max_failures {
                    status.send_replace(Status::Failed { reason });
                    match cmd_rx.recv().await {
                        Some(Cmd::Restart) => {
                            failures.clear();
                            backoff = policy.backoff_initial;
                            attempt = 0;
                            continue;
                        }
                        Some(Cmd::Stop) | None => {
                            status.send_replace(Status::Stopped);
                            return;
                        }
                    }
                }
                attempt += 1;
                status.send_replace(Status::Restarting { attempt, reason });
                tokio::select! {
                    _ = sleep(backoff) => {}
                    cmd = cmd_rx.recv() => match cmd {
                        Some(Cmd::Restart) => {
                            failures.clear();
                            backoff = policy.backoff_initial;
                            attempt = 0;
                            continue;
                        }
                        Some(Cmd::Stop) | None => {
                            status.send_replace(Status::Stopped);
                            return;
                        }
                    }
                }
                backoff = (backoff * 2).min(policy.backoff_max);
            }
        }
    }
}

/// The whole life of one child. Always returns with the child gone.
async fn run_one(
    spec: &SidecarSpec,
    policy: &Policy,
    status: &watch::Sender<Status>,
    cmd_rx: &mut mpsc::UnboundedReceiver<Cmd>,
) -> (Exit, Option<Instant>) {
    let mut child = match spawn(spec, policy) {
        Ok(child) => child,
        Err(e) => return (Exit::Failure(format!("could not start {}: {e}", spec.program.display())), None),
    };
    if let (Some(pid), Some(file)) = (child.id(), spec.pid_file.as_ref()) {
        let _ = std::fs::write(file, pid.to_string());
    }
    let started = Instant::now();
    let mut ready_at: Option<Instant> = None;
    let mut failed_checks = 0u32;

    let exit = loop {
        let wait = if ready_at.is_some() { policy.health_interval } else { policy.startup_poll };
        tokio::select! {
            exited = child.wait() => {
                break Exit::Failure(match exited {
                    Ok(code) => format!("server exited ({code})"),
                    Err(e) => format!("lost the server process: {e}"),
                });
            }
            cmd = cmd_rx.recv() => {
                terminate(&mut child, policy.stop_grace).await;
                break match cmd { Some(Cmd::Restart) => Exit::Restart, Some(Cmd::Stop) | None => Exit::Stop };
            }
            _ = sleep(wait) => {
                let ok = is_healthy(spec.health_port, &spec.health_path, policy.health_timeout).await;
                if ready_at.is_none() {
                    if ok {
                        ready_at = Some(Instant::now());
                        status.send_replace(Status::Running);
                    } else if started.elapsed() > policy.startup_timeout {
                        terminate(&mut child, policy.stop_grace).await;
                        break Exit::Failure(format!("server did not answer {} within {:?}", spec.health_path, policy.startup_timeout));
                    }
                } else if ok {
                    failed_checks = 0;
                } else {
                    failed_checks += 1;
                    if failed_checks >= policy.health_failures {
                        terminate(&mut child, policy.stop_grace).await;
                        break Exit::Failure(format!("{failed_checks} health checks in a row failed"));
                    }
                }
            }
        }
    };
    if let Some(file) = spec.pid_file.as_ref() {
        let _ = std::fs::remove_file(file);
    }
    (exit, ready_at)
}

fn spawn(spec: &SidecarSpec, policy: &Policy) -> io::Result<Child> {
    if let Some(dir) = spec.log_file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    rotate_log(&spec.log_file, policy.max_log_bytes);
    let log = std::fs::OpenOptions::new().create(true).append(true).open(&spec.log_file)?;
    let log_err = log.try_clone()?;

    let mut command = Command::new(&spec.program);
    command.args(&spec.args).env_clear();
    for name in INHERITED_ENV {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.envs(spec.env.iter().map(|(k, v)| (k, v)));
    command.stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log_err)).kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0); // a Ctrl-C in a dev terminal reaches the shell, which then stops the server itself
    command.spawn()
}

fn rotate_log(path: &Path, max: u64) {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > max) {
        let mut old = path.as_os_str().to_owned();
        old.push(".1");
        let _ = std::fs::rename(path, old);
    }
}

/// SIGTERM, wait `grace`, then SIGKILL.
pub(crate) async fn terminate(child: &mut Child, grace: Duration) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: plain signal delivery to a child we own.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    }
    #[cfg(not(unix))]
    {
        let _ = child.start_kill();
    }
    if timeout(grace, child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
}

/// If the pid file names a live process whose executable name starts with `expected_name`, stops it (SIGTERM, then SIGKILL
/// after `grace`) and removes the file. Handles a shell that was killed without stopping its server. Returns the pid stopped.
#[cfg(unix)]
pub fn reap_stale(pid_file: &Path, expected_name: &str, grace: Duration) -> Option<u32> {
    let pid: u32 = std::fs::read_to_string(pid_file).ok()?.trim().parse().ok()?;
    let _ = std::fs::remove_file(pid_file);
    if pid <= 1 || !process_alive(pid) || !process_name(pid)?.starts_with(expected_name) {
        return None;
    }
    // SAFETY: plain signal delivery; the process was verified by name above.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    let deadline = Instant::now() + grace;
    while process_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if process_alive(pid) {
        // SAFETY: as above.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }
    Some(pid)
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks for existence. A zombie still counts as alive until reaped, which is fine here.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(unix)]
fn process_name(pid: u32) -> Option<String> {
    let out = std::process::Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "comm="]).output().ok()?;
    let comm = String::from_utf8(out.stdout).ok()?;
    Path::new(comm.trim()).file_name().map(|n| n.to_string_lossy().into_owned())
}
