//! This install's embedded wurmhol tunnel (wurmhol ADR 0032), from the Dorks tunnel service (`infra/tunnels`).
//!
//! The service holds Dorks' integration key, so no wurmhol account, login or approval is needed here. It knows this install by
//! its install key and answers `POST /v1/tunnel` with the install's one private tunnel (`{id, url}`, the same every time) and a
//! fresh connector (`whc_…`, valid 365 days, any older one revoked). The connector is all the wurmhol client needs to open the
//! tunnel. It is kept in a 0600 file and asked for again after [`REFRESH_AFTER`], or when the client refuses it.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::secrets::{read_secret, write_private};
use crate::settings::validate_public_url;

/// Well inside the connector's 365 days, so an install that is rarely opened never starts with an expired one.
pub const REFRESH_AFTER: Duration = Duration::from_secs(180 * 24 * 3600);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    /// `whc_…`. Reaches the client only as `WURMHOL_TOKEN`.
    pub connector: String,
    pub tunnel_id: String,
    /// The tunnel's URL, stable across reopens.
    pub url: String,
    /// Unix seconds when the service issued it.
    pub fetched_at: u64,
    /// The tunnel service it came from. Another service is another wurmhol application and tunnel, so a connector kept from one
    /// is never used with the other (the server would register sandboxes on a tunnel this connector does not open).
    #[serde(default)]
    pub service: String,
}

#[derive(Deserialize)]
struct Answer {
    tunnel: AnswerTunnel,
    connector: AnswerConnector,
}

#[derive(Deserialize)]
struct AnswerTunnel {
    id: String,
    url: String,
}

#[derive(Deserialize)]
struct AnswerConnector {
    connector: String,
}

#[derive(Deserialize)]
struct Refusal {
    fix: Option<String>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `whc_` and 43 base64url characters (wurmhol's shape for every embedded credential).
pub fn is_connector(value: &str) -> bool {
    value.strip_prefix("whc_").is_some_and(|rest| rest.len() == 43 && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
}

/// Asks the service for this install's tunnel and a new connector.
pub async fn request(service: &str, install_key: &str) -> Result<Connector, String> {
    let url = format!("{}/v1/tunnel", service.trim_end_matches('/'));
    // reqwest is built without a crypto provider; ring is the one the app already carries. Installing twice is a no-op.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build().map_err(|e| e.to_string())?;
    let res = client
        .post(&url)
        .bearer_auth(install_key)
        .header("user-agent", concat!("dorks-desktop/", env!("CARGO_PKG_VERSION")))
        .send()
        .await
        .map_err(|e| format!("cannot reach the Dorks tunnel service at {service}: {}", e.without_url()))?;
    let status = res.status();
    if !status.is_success() {
        let fix = res.json::<Refusal>().await.ok().and_then(|r| r.fix).unwrap_or_default();
        return Err(format!("the Dorks tunnel service refused ({status}){}", if fix.is_empty() { String::new() } else { format!(": {fix}") }));
    }
    let answer: Answer = res.json().await.map_err(|_| "the Dorks tunnel service sent an answer that cannot be read".to_string())?;
    if !is_connector(&answer.connector.connector) {
        return Err("the Dorks tunnel service sent no connector".into());
    }
    let url = validate_public_url(&answer.tunnel.url).map_err(|e| format!("the Dorks tunnel service sent a tunnel URL that cannot be used: {e}"))?;
    Ok(Connector { connector: answer.connector.connector, tunnel_id: answer.tunnel.id, url, fetched_at: now(), service: normalize(service) })
}

fn normalize(service: &str) -> String {
    service.trim().trim_end_matches('/').to_string()
}

/// The stored connector, unless it is missing, unreadable, due for refresh, or from another tunnel service than `service`.
pub fn stored(file: &Path, service: &str) -> Option<Connector> {
    let text = read_secret(file).ok().flatten()?;
    let c: Connector = serde_json::from_str(&text).ok()?;
    (is_connector(&c.connector) && c.service == normalize(service) && now().saturating_sub(c.fetched_at) < REFRESH_AFTER.as_secs()).then_some(c)
}

/// The connector to open the tunnel with: the stored one, or (when there is none, it is due, or `fresh` is asked for) a new one
/// from the service, which is then stored.
pub async fn obtain(file: &Path, service: &str, install_key: &str, fresh: bool) -> Result<Connector, String> {
    if !fresh {
        if let Some(c) = stored(file, service) {
            return Ok(c);
        }
    }
    let c = request(service, install_key).await?;
    let json = serde_json::to_vec(&c).map_err(|e| e.to_string())?;
    write_private(file, &json).map_err(|e| format!("cannot save the tunnel connector: {e}"))?;
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_shape() {
        assert!(is_connector(&format!("whc_{}", "a".repeat(43))));
        assert!(!is_connector(&format!("whk_{}", "a".repeat(43))));
        assert!(!is_connector("whc_short"));
        assert!(!is_connector(&format!("whc_{}", "a/".repeat(21) + "a")));
    }

    #[test]
    fn stored_connector_is_used_until_it_is_due() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("wurmhol-connector");
        let svc = "https://tunnels.example";
        assert_eq!(stored(&file, svc), None);
        let mut c = Connector { connector: format!("whc_{}", "b".repeat(43)), tunnel_id: "t1".into(), url: "https://e1.pipe.example".into(), fetched_at: now(), service: svc.into() };
        write_private(&file, &serde_json::to_vec(&c).unwrap()).unwrap();
        assert_eq!(stored(&file, "https://tunnels.example/"), Some(c.clone()));
        assert_eq!(stored(&file, "https://staging-tunnels.example"), None, "another service's connector is not used");
        c.fetched_at = now() - REFRESH_AFTER.as_secs() - 1;
        write_private(&file, &serde_json::to_vec(&c).unwrap()).unwrap();
        assert_eq!(stored(&file, svc), None);
    }
}
