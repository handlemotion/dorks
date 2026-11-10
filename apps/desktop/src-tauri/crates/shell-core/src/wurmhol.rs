//! The wurmhol tunnel provider: runs the wurmhol client (`wurmhol <port> --json`, handlemotion/wurmhol `packages/cli`) against
//! the server's bridge port and reports the URL it prints.
//!
//! The client is a separate executable so the shell stays free of the relay protocol. Two shapes are supported, because the
//! client changes:
//!
//! - **Detaching** (what the client does today): it prints `{"url","port","id"}` and exits 0 while a daemon keeps the pipe
//!   open. Health is `wurmhol ls --json` still listing the id; stopping is `wurmhol stop <id>`.
//! - **Foreground** (a proposal, see docs/desktop.md): it prints the same line and stays alive. Health is the process;
//!   stopping is SIGTERM.
//!
//! The token reaches the client only through `WURMHOL_TOKEN` in its environment, never its arguments. Only the bridge port is
//! ever passed. See docs/desktop.md for what the hosted relay cannot do yet (stable names, machine access).

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

use crate::settings::validate_public_url;
use crate::supervisor::{terminate, INHERITED_ENV};
use crate::tunnel::{BoxFuture, Tunnel, TunnelEndpoint, TunnelError, TunnelHealth, TunnelTarget};

/// Variables the client needs besides [`INHERITED_ENV`]: proxies (the client dials out through `HTTPS_PROXY`) and a proxy CA.
const PASSTHROUGH_ENV: &[&str] = &["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS"];

/// Where a GUI app on macOS usually will not look but `node` (which the client runs on) usually lives.
const EXTRA_BIN_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

#[derive(Debug, Clone)]
pub struct WurmholConfig {
    pub bin: PathBuf,
    /// `None` until the user adds a token; start then fails with a message that says where.
    pub token: Option<String>,
    /// A self-hosted install, passed as `WURMHOL_URL`.
    pub server: Option<String>,
    pub extra_args: Vec<String>,
    /// stderr of the client is appended here.
    pub log_file: PathBuf,
    pub start_timeout: Duration,
    pub poll_interval: Duration,
    pub stop_grace: Duration,
}

impl WurmholConfig {
    pub fn new(bin: PathBuf, log_file: PathBuf) -> Self {
        Self {
            bin,
            token: None,
            server: None,
            extra_args: vec![],
            log_file,
            start_timeout: Duration::from_secs(30),
            poll_interval: Duration::from_secs(10),
            stop_grace: Duration::from_secs(3),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Ready {
    pub url: String,
    pub id: String,
}

#[derive(Deserialize)]
struct ReadyJson {
    url: String,
    id: String,
}

/// Parses the client's first stdout line (`--json`): `{"url":"https://…","port":4748,"id":"k3x9p2abcd"}`.
pub fn parse_ready_line(line: &str) -> Result<Ready, String> {
    let parsed: ReadyJson = serde_json::from_str(line.trim()).map_err(|_| format!("unexpected output from wurmhol: {}", truncate(line)))?;
    // The id is later passed to `wurmhol stop <id>`: it must not be able to look like a flag.
    let id_ok = !parsed.id.is_empty()
        && parsed.id.len() <= 64
        && parsed.id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && parsed.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !id_ok {
        return Err("wurmhol reported a pipe id that is not valid".into());
    }
    let url = validate_public_url(&parsed.url).map_err(|e| format!("wurmhol reported a URL that cannot be used: {e}"))?;
    Ok(Ready { url, id: parsed.id })
}

fn truncate(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() > 120 {
        format!("{}…", s.chars().take(120).collect::<String>())
    } else {
        s.to_string()
    }
}

/// Whether `wurmhol ls --json` output lists the pipe.
pub fn listing_has(output: &str, id: &str) -> bool {
    #[derive(Deserialize)]
    struct Item {
        id: String,
    }
    serde_json::from_str::<Vec<Item>>(output.trim()).is_ok_and(|items| items.iter().any(|i| i.id == id))
}

/// Arguments after the program name: the bridge port, JSON output, then the user's extras.
pub fn start_args(port: u16, extra: &[String]) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![port.to_string().into(), "--json".into()];
    args.extend(extra.iter().map(OsString::from));
    args
}

/// The client's `PATH`: the shell's own, plus the usual places `node` lives (a menu-bar app starts with a minimal PATH).
pub fn child_path(path_var: Option<&OsStr>, home: Option<&Path>) -> OsString {
    let mut dirs: Vec<PathBuf> = path_var.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    let mut extra: Vec<PathBuf> = EXTRA_BIN_DIRS.iter().map(PathBuf::from).collect();
    if let Some(home) = home {
        extra.push(home.join(".local/bin"));
    }
    for dir in extra {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// `$WURMHOL_BIN`; else `wurmhol` next to the app executable; else on the extended PATH.
pub fn find_wurmhol(env_bin: Option<&OsStr>, exe_dir: Option<&Path>, path_var: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(bin) = env_bin.map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(bin);
    }
    if let Some(sibling) = exe_dir.map(|d| d.join("wurmhol")).filter(|p| p.is_file()) {
        return Some(sibling);
    }
    std::env::split_paths(&child_path(path_var, home)).map(|d| d.join("wurmhol")).find(|p| p.is_file())
}

enum Mode {
    /// The client exited after printing; a daemon holds the pipe.
    Detached,
    /// The client is still running and is the pipe.
    Foreground(Child),
}

struct Active {
    stop: Option<oneshot::Sender<()>>,
    monitor: JoinHandle<()>,
}

pub struct WurmholTunnel {
    cfg: WurmholConfig,
    health: watch::Sender<TunnelHealth>,
    active: tokio::sync::Mutex<Option<Active>>,
}

impl WurmholTunnel {
    pub fn new(cfg: WurmholConfig) -> Self {
        let (health, _) = watch::channel(TunnelHealth::Up);
        Self { cfg, health, active: tokio::sync::Mutex::new(None) }
    }

    async fn launch(&self, port: u16) -> Result<(Ready, Mode, Arc<Mutex<String>>), TunnelError> {
        if self.cfg.token.is_none() {
            return Err(TunnelError::Failed(
                "no wurmhol token yet: create one at https://dirt.wurmhol.com (menu, Tokens) and add it in Settings".into(),
            ));
        }
        let mut child = command(&self.cfg, &start_args(port, &self.cfg.extra_args))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| TunnelError::Failed(format!("cannot run {}: {e}; install it with `npm i -g wurmhol` or set WURMHOL_BIN", self.cfg.bin.display())))?;
        let stdout = child.stdout.take().expect("piped");
        let stderr = child.stderr.take().expect("piped");
        let last_error = Arc::new(Mutex::new(String::new()));
        drain_stderr(stderr, self.cfg.log_file.clone(), last_error.clone());

        let mut lines = BufReader::new(stdout).lines();
        let first = match timeout(self.cfg.start_timeout, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) | Ok(Err(_)) => {
                // Closed without a URL: the client failed and said why on stderr.
                let _ = timeout(Duration::from_secs(2), child.wait()).await;
                sleep(Duration::from_millis(100)).await;
                let why = last_error.lock().unwrap().clone();
                return Err(TunnelError::Failed(if why.is_empty() { "wurmhol exited without opening a pipe".into() } else { why }));
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err(TunnelError::Failed(format!("wurmhol did not open a pipe within {} s", self.cfg.start_timeout.as_secs())));
            }
        };
        let ready = match parse_ready_line(&first) {
            Ok(r) => r,
            Err(e) => {
                let _ = child.kill().await;
                return Err(TunnelError::Failed(e));
            }
        };
        // Keep reading so a client that stays alive can never block on a full pipe.
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        // Detaching clients exit within milliseconds of printing; one that is still running after this is the pipe itself.
        let mode = match timeout(Duration::from_millis(750), child.wait()).await {
            Ok(Ok(status)) if status.success() => Mode::Detached,
            Ok(Ok(status)) => return Err(TunnelError::Failed(format!("wurmhol exited ({status}) right after opening the pipe"))),
            Ok(Err(e)) => return Err(TunnelError::Failed(format!("cannot wait for wurmhol: {e}"))),
            Err(_) => Mode::Foreground(child),
        };
        Ok((ready, mode, last_error))
    }
}

impl Tunnel for WurmholTunnel {
    fn kind(&self) -> &'static str {
        "wurmhol"
    }

    fn start(&self, target: TunnelTarget) -> BoxFuture<'_, Result<TunnelEndpoint, TunnelError>> {
        Box::pin(async move {
            let mut active = self.active.lock().await;
            if let Some(old) = active.take() {
                finish(old).await;
            }
            let (ready, mode, last_error) = self.launch(target.bridge_port).await?;
            let (stop_tx, stop_rx) = oneshot::channel();
            let monitor = tokio::spawn(monitor(self.cfg.clone(), ready.id, mode, last_error, stop_rx, self.health.clone()));
            *active = Some(Active { stop: Some(stop_tx), monitor });
            let _ = self.health.send(TunnelHealth::Up);
            Ok(TunnelEndpoint { public_url: ready.url })
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if let Some(old) = self.active.lock().await.take() {
                finish(old).await;
            }
        })
    }

    fn watch(&self) -> Option<watch::Receiver<TunnelHealth>> {
        Some(self.health.subscribe())
    }
}

async fn finish(mut active: Active) {
    if let Some(stop) = active.stop.take() {
        let _ = stop.send(());
    }
    let _ = timeout(Duration::from_secs(15), &mut active.monitor).await;
    active.monitor.abort();
}

/// Watches one pipe until it is stopped (then ends it) or lost (then says so once and returns).
async fn monitor(
    cfg: WurmholConfig,
    id: String,
    mode: Mode,
    last_error: Arc<Mutex<String>>,
    mut stop: oneshot::Receiver<()>,
    health: watch::Sender<TunnelHealth>,
) {
    match mode {
        Mode::Foreground(mut child) => {
            tokio::select! {
                _ = &mut stop => terminate(&mut child, cfg.stop_grace).await,
                status = child.wait() => {
                    let why = last_error.lock().unwrap().clone();
                    let reason = match status {
                        Ok(s) if !why.is_empty() => format!("wurmhol exited ({s}): {why}"),
                        Ok(s) => format!("wurmhol exited ({s})"),
                        Err(e) => format!("wurmhol: {e}"),
                    };
                    let _ = health.send(TunnelHealth::Lost(reason));
                }
            }
        }
        Mode::Detached => {
            let mut misses = 0u32;
            loop {
                tokio::select! {
                    _ = &mut stop => {
                        let _ = timeout(Duration::from_secs(8), command(&cfg, &[OsString::from("stop"), OsString::from(&id)]).stdout(Stdio::null()).stderr(Stdio::null()).status()).await;
                        return;
                    }
                    _ = sleep(cfg.poll_interval) => {}
                }
                let listing = timeout(Duration::from_secs(10), command(&cfg, &[OsString::from("ls"), OsString::from("--json")]).stderr(Stdio::null()).output()).await;
                match listing {
                    Ok(Ok(out)) if out.status.success() => {
                        misses = 0;
                        if !listing_has(&String::from_utf8_lossy(&out.stdout), &id) {
                            let _ = health.send(TunnelHealth::Lost("the pipe ended (stopped, expired or revoked)".into()));
                            return;
                        }
                    }
                    // `ls` itself failing is not proof the pipe died; three in a row is.
                    _ => {
                        misses += 1;
                        if misses >= 3 {
                            let _ = health.send(TunnelHealth::Lost("cannot check the pipe: `wurmhol ls` keeps failing".into()));
                            return;
                        }
                    }
                }
            }
        }
    }
}

fn command(cfg: &WurmholConfig, args: &[OsString]) -> Command {
    let mut cmd = Command::new(&cfg.bin);
    cmd.args(args).stdin(Stdio::null()).kill_on_drop(true).env_clear();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    for name in INHERITED_ENV.iter().filter(|n| **n != "PATH").chain(PASSTHROUGH_ENV) {
        if let Some(value) = std::env::var_os(name) {
            cmd.env(name, value);
        }
    }
    cmd.env("PATH", child_path(std::env::var_os("PATH").as_deref(), home.as_deref()));
    if let Some(token) = &cfg.token {
        cmd.env("WURMHOL_TOKEN", token);
    }
    if let Some(server) = &cfg.server {
        cmd.env("WURMHOL_URL", server);
    }
    cmd
}

/// Appends the client's stderr to the log and remembers its last line (it states the fix in one line).
fn drain_stderr(stderr: tokio::process::ChildStderr, log_file: PathBuf, last: Arc<Mutex<String>>) {
    tokio::spawn(async move {
        let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(&log_file).await.ok();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(f) = file.as_mut() {
                let _ = f.write_all(format!("{line}\n").as_bytes()).await;
            }
            *last.lock().unwrap() = line.trim().strip_prefix("wurmhol: ").unwrap_or(line.trim()).to_string();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line_is_parsed_and_validated() {
        let ok = parse_ready_line(r#"{"url":"https://k3x9p2abcd.pipe.wurmhol.com","port":4748,"id":"k3x9p2abcd"}"#).unwrap();
        assert_eq!(ok, Ready { url: "https://k3x9p2abcd.pipe.wurmhol.com".into(), id: "k3x9p2abcd".into() });
        assert!(parse_ready_line("https://k3x9p2abcd.pipe.wurmhol.com").is_err(), "plain mode output is not accepted");
        assert!(parse_ready_line(r#"{"url":"http://insecure.example","id":"abc"}"#).is_err());
        assert!(parse_ready_line(r#"{"url":"https://a.example","id":"--all"}"#).is_err());
        assert!(parse_ready_line(r#"{"url":"https://a.example","id":""}"#).is_err());
        assert!(parse_ready_line(r#"{"url":"https://u:p@a.example","id":"abc"}"#).is_err());
    }

    #[test]
    fn listing_is_matched_by_id() {
        let out = r#"[{"id":"aaa","url":"https://x","port":1,"startedAt":"t"},{"id":"bbb","url":"https://y","port":2,"startedAt":"t"}]"#;
        assert!(listing_has(out, "bbb"));
        assert!(!listing_has(out, "ccc"));
        assert!(!listing_has("not json", "aaa"));
        assert!(!listing_has("[]", "aaa"));
    }

    #[test]
    fn arguments_carry_only_the_port_then_extras() {
        let args = start_args(4748, &["--name".into(), "mine".into()]);
        assert_eq!(args, vec![OsString::from("4748"), "--json".into(), "--name".into(), "mine".into()]);
    }

    #[test]
    fn path_gains_node_locations_once() {
        let path = child_path(Some(OsStr::new("/usr/bin:/opt/homebrew/bin")), Some(Path::new("/Users/me")));
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        assert_eq!(dirs, vec![PathBuf::from("/usr/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into(), "/Users/me/.local/bin".into()]);
    }

    #[test]
    fn binary_lookup_prefers_env_then_sibling_then_path() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b, c) = (dir.path().join("a"), dir.path().join("b"), dir.path().join("c"));
        for d in [&a, &b, &c] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("wurmhol"), "").unwrap();
        }
        let path = std::env::join_paths([&c]).unwrap();
        assert_eq!(find_wurmhol(Some(a.join("wurmhol").as_os_str()), Some(&b), Some(&path), None), Some(a.join("wurmhol")));
        assert_eq!(find_wurmhol(Some(OsStr::new("/nope")), Some(&b), Some(&path), None), Some(b.join("wurmhol")));
        assert_eq!(find_wurmhol(None, Some(Path::new("/nope")), Some(&path), None), Some(c.join("wurmhol")));
        assert_eq!(find_wurmhol(None, None, Some(OsStr::new("/nope")), None).is_some(), std::path::Path::new("/opt/homebrew/bin/wurmhol").is_file() || std::path::Path::new("/usr/local/bin/wurmhol").is_file());
    }
}
