//! The tunnel interface. Boat sandboxes run in the cloud and their bridges connect *out* to the server, so the server's bridge
//! port needs a public URL. Something provides it by implementing [`Tunnel`]:
//!
//! - [`UserUrlTunnel`]: the user already exposes the port (own domain, reverse proxy, another tunnel) and gives the URL.
//! - [`WurmholTunnel`] (module `wurmhol`): runs the wurmhol client against the bridge port and reports the URL it prints.
//!
//! Only the bridge port is ever exposed; the UI port stays on loopback.

use std::future::Future;
use std::pin::Pin;

use serde::Serialize;
use tokio::sync::watch;

use crate::settings::validate_public_url;
pub use crate::wurmhol::{WurmholConfig, WurmholTunnel};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the tunnel should forward to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TunnelTarget {
    pub bridge_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelEndpoint {
    /// Public https URL of the bridge port, without a trailing slash.
    pub public_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelError {
    NotImplemented(&'static str),
    Invalid(String),
    Failed(String),
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TunnelError::NotImplemented(what) => write!(f, "{what} is not implemented yet"),
            TunnelError::Invalid(msg) | TunnelError::Failed(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for TunnelError {}

/// What a running tunnel reports about itself after it started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelHealth {
    Up,
    /// The tunnel is gone; the reason is for the UI. Reported once, after which the owner decides what to do.
    Lost(String),
}

pub trait Tunnel: Send + Sync {
    /// Short stable name for the UI: `"user-url"`, `"wurmhol"`.
    fn kind(&self) -> &'static str;
    /// Brings the tunnel up and returns the public URL. Called before the server starts, so the URL can be passed to it.
    fn start(&self, target: TunnelTarget) -> BoxFuture<'_, Result<TunnelEndpoint, TunnelError>>;
    /// Tears it down. Must be safe to call when it never started.
    fn stop(&self) -> BoxFuture<'_, ()>;
    /// Health updates for tunnels that can die on their own. `None` for tunnels that cannot be observed.
    fn watch(&self) -> Option<watch::Receiver<TunnelHealth>> {
        None
    }
}

/// The user supplies the public URL; nothing is started.
pub struct UserUrlTunnel {
    url: String,
}

impl UserUrlTunnel {
    pub fn new(url: &str) -> Result<Self, TunnelError> {
        validate_public_url(url).map(|url| Self { url }).map_err(TunnelError::Invalid)
    }
}

impl Tunnel for UserUrlTunnel {
    fn kind(&self) -> &'static str {
        "user-url"
    }

    fn start(&self, _target: TunnelTarget) -> BoxFuture<'_, Result<TunnelEndpoint, TunnelError>> {
        Box::pin(async move { Ok(TunnelEndpoint { public_url: self.url.clone() }) })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

/// Chooses the tunnel: a URL from the environment, else one saved in settings, else wurmhol.
pub fn select(env_url: Option<&str>, settings_url: Option<&str>, wurmhol: WurmholConfig) -> Result<Box<dyn Tunnel>, TunnelError> {
    let url = env_url.filter(|u| !u.trim().is_empty()).or(settings_url.filter(|u| !u.trim().is_empty()));
    match url {
        Some(url) => Ok(Box::new(UserUrlTunnel::new(url)?)),
        None => Ok(Box::new(WurmholTunnel::new(wurmhol))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn user_url_is_validated_and_returned() {
        let t = UserUrlTunnel::new("https://me.example.com/").unwrap();
        let endpoint = t.start(TunnelTarget { bridge_port: 1 }).await.unwrap();
        assert_eq!(endpoint.public_url, "https://me.example.com");
        assert_eq!(t.kind(), "user-url");
        assert!(UserUrlTunnel::new("http://me.example.com").is_err());
    }

    #[test]
    fn selection_prefers_environment_then_settings_then_wurmhol() {
        let cfg = || WurmholConfig::new("wurmhol".into(), "wurmhol.log".into());
        assert_eq!(select(Some("https://env.example"), Some("https://saved.example"), cfg()).unwrap().kind(), "user-url");
        assert_eq!(select(None, Some("https://saved.example"), cfg()).unwrap().kind(), "user-url");
        assert_eq!(select(Some(" "), None, cfg()).unwrap().kind(), "wurmhol");
        assert_eq!(select(None, None, cfg()).unwrap().kind(), "wurmhol");
        assert!(select(Some("http://insecure.example"), None, cfg()).is_err());
    }
}
