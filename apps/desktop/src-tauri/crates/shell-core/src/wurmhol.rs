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
    /// A token the user saved. `None` is fine: the client then asks for a device-login approval (`approval` in its output) and
    /// keeps the token it is granted in its own credentials file.
    pub token: Option<String>,
    /// Passed as `WURMHOL_ACCESS_KEY`: lets a sandbox's bridge through the relay without a browser sign-in. Needs a relay that has
    /// the access-key support (an older one ignores it, and sandboxes then get 401 at the relay).
    pub access_key: Option<String>,
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
            access_key: None,
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
    /// The pipe's URL, or the approval link when `approval` is set.
    pub url: String,
    pub id: String,
    pub approval: bool,
}

#[derive(Deserialize)]
struct ReadyJson {
    url: String,
    id: String,
    #[serde(default)]
    approval: bool,
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
    // An approval link is a page the person opens (it has a `?code=`); a pipe URL becomes the bridge's public origin.
    let url = if parsed.approval {
        validate_approval_link(&parsed.url).map_err(|e| format!("wurmhol reported an approval link that cannot be used: {e}"))?
    } else {
        validate_public_url(&parsed.url).map_err(|e| format!("wurmhol reported a URL that cannot be used: {e}"))?
    };
    Ok(Ready { url, id: parsed.id, approval: parsed.approval })
}

/// An `https://` page, with no credentials and no whitespace or control characters; its query is allowed.
fn validate_approval_link(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    let authority = url.strip_prefix("https://").ok_or("the link must be https://")?.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') || url.len() > 512 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("not a plain https link".into());
    }
    Ok(url.to_string())
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
    listing_state(output, id).is_some()
}

/// The pipe's state in `wurmhol ls --json` output: `None` when it is not listed, else whether it still waits for approval.
pub fn listing_state(output: &str, id: &str) -> Option<bool> {
    #[derive(Deserialize)]
    struct Item {
        id: String,
        #[serde(default)]
        approval: bool,
    }
    serde_json::from_str::<Vec<Item>>(output.trim()).ok()?.into_iter().find(|i| i.id == id).map(|i| i.approval)
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
        let mut cmd = command(&self.cfg, &start_args(port, &self.cfg.extra_args));
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = spawn_retrying(&mut cmd)
            .await
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
            if ready.approval {
                // The daemon waits for a person to approve this computer; watch until it has, then tell the shell to start over.
                let (stop_tx, stop_rx) = oneshot::channel();
                let monitor = tokio::spawn(await_approval(self.cfg.clone(), ready.id, stop_rx, self.health.clone()));
                *active = Some(Active { stop: Some(stop_tx), monitor });
                return Err(TunnelError::ApprovalNeeded(ready.url));
            }
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

/// While the client's daemon waits for a person to approve this computer: polls `wurmhol ls --json` until the share no longer
/// waits (then reports [`TunnelHealth::Approved`]) or is gone (then reports it lost). Ends the share when told to stop.
async fn await_approval(cfg: WurmholConfig, id: String, mut stop: oneshot::Receiver<()>, health: watch::Sender<TunnelHealth>) {
    let poll = cfg.poll_interval.min(Duration::from_secs(3));
    loop {
        tokio::select! {
            _ = &mut stop => {
                let _ = timeout(Duration::from_secs(8), command(&cfg, &[OsString::from("stop"), OsString::from(&id)]).stdout(Stdio::null()).stderr(Stdio::null()).status()).await;
                return;
            }
            _ = sleep(poll) => {}
        }
        let listing = timeout(Duration::from_secs(10), command(&cfg, &[OsString::from("ls"), OsString::from("--json")]).stderr(Stdio::null()).output()).await;
        if let Ok(Ok(out)) = listing {
            if out.status.success() {
                match listing_state(&String::from_utf8_lossy(&out.stdout), &id) {
                    Some(true) => {}
                    Some(false) => {
                        let _ = health.send(TunnelHealth::Approved);
                        return;
                    }
                    None => {
                        let _ = health.send(TunnelHealth::Lost("the approval was not completed (the code expired or was cancelled)".into()));
                        return;
                    }
                }
            }
        }
    }
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

/// Linux refuses to exec a file that some process still holds open for writing (`ETXTBSY`): the client binary being rewritten
/// by `npm i -g wurmhol`, or a write handle another thread's freshly forked child inherited for the instant before its own exec.
/// Both clear within milliseconds, so retry briefly instead of failing the tunnel.
async fn spawn_retrying(cmd: &mut Command) -> std::io::Result<Child> {
    const ETXTBSY: i32 = 26;
    let mut attempt = 0;
    loop {
        match cmd.spawn() {
            Err(e) if e.raw_os_error() == Some(ETXTBSY) && attempt < 10 => {
                attempt += 1;
                sleep(Duration::from_millis(20 * attempt)).await;
            }
            other => return other,
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
    if let Some(key) = &cfg.access_key {
        cmd.env("WURMHOL_ACCESS_KEY", key);
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
        assert_eq!(ok, Ready { url: "https://k3x9p2abcd.pipe.wurmhol.com".into(), id: "k3x9p2abcd".into(), approval: false });
        let waiting = parse_ready_line(r#"{"url":"https://dirt.wurmhol.com/device?code=ABCD-EFGH","port":4748,"id":"wait1","approval":true}"#).unwrap();
        assert!(waiting.approval);
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

}
