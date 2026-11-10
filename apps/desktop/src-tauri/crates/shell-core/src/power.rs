//! Keep-awake: while dorks are active the Mac must not idle-sleep, or the tunnel and server stop with it.
//!
//! On macOS this holds a power assertion by running `caffeinate -i -w <our pid>`: `-i` is the "prevent idle system sleep"
//! assertion, and `-w` ties its lifetime to this process, so even a crash of the shell releases it. The display may still
//! sleep. Other platforms: no-op.

use std::process::{Child, Command, Stdio};

#[derive(Default)]
pub struct KeepAwake {
    child: Option<Child>,
}

impl KeepAwake {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes or releases the assertion. Idempotent. Returns whether it is held afterwards.
    pub fn set(&mut self, active: bool) -> bool {
        self.reap();
        match (active, self.child.is_some()) {
            (true, false) => self.child = spawn_caffeinate(),
            (false, true) => self.release(),
            _ => {}
        }
        self.child.is_some()
    }

    pub fn is_active(&mut self) -> bool {
        self.reap();
        self.child.is_some()
    }

    fn release(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Forgets a caffeinate that exited by itself.
    fn reap(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
                self.child = None;
            }
        }
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(target_os = "macos")]
fn spawn_caffeinate() -> Option<Child> {
    Command::new("/usr/bin/caffeinate")
        .args(["-i", "-w", &std::process::id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

#[cfg(not(target_os = "macos"))]
fn spawn_caffeinate() -> Option<Child> {
    let _ = (Command::new("true"), Stdio::null());
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn takes_and_releases_the_assertion() {
        let mut awake = KeepAwake::new();
        assert!(!awake.is_active());
        assert!(awake.set(true));
        assert!(awake.set(true), "idempotent");
        assert!(awake.is_active());
        assert!(!awake.set(false));
        assert!(!awake.is_active());
    }

    #[test]
    fn dropping_releases() {
        let mut awake = KeepAwake::new();
        awake.set(true);
        let pid = awake.child.as_ref().unwrap().id();
        drop(awake);
        // SAFETY: signal 0 only checks existence; the child was waited on, so the pid is gone.
        assert_ne!(unsafe { libc::kill(pid as libc::pid_t, 0) }, 0);
    }
}
