//! Webview navigation policy for the desktop window.
//!
//! WKWebView invokes Tauri's `on_navigation` callback for both top-level navigations and embedded
//! `<iframe>` loads without indicating which frame triggered the navigation. Every origin permitted
//! by `tauri.conf.json`'s `frame-src` (Boat desktop streams, Boat hosted previews, and local/sim
//! previews) must therefore be allowed here; otherwise opening the Computer tab or a preview cancels
//! the iframe and opens its URL in the system browser instead.
//!
//! Explicit external links (`target="_blank"`, `window.open`) go through `on_new_window`, so
//! "Open in a window" / "Open in a new tab" still opens in the default browser even for Boat URLs.

/// Returns `true` when `url` (given as its scheme and optional host) may load inside the desktop
/// webview (either as the bundled UI or inside an embedded `<iframe>`).
pub fn allow_in_webview(scheme: &str, host: Option<&str>) -> bool {
    let scheme = scheme.to_ascii_lowercase();
    if matches!(scheme.as_str(), "tauri" | "about" | "data" | "blob") {
        return true;
    }
    let Some(host) = host else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    match scheme.as_str() {
        "http" | "https" if matches!(host.as_str(), "tauri.localhost" | "localhost" | "127.0.0.1") => true,
        "https" => is_boat_subdomain(&host),
        _ => false,
    }
}

fn is_boat_subdomain(host: &str) -> bool {
    host.strip_suffix(".on.boat.dev")
        .is_some_and(|sub| !sub.is_empty() && !sub.starts_with('.') && !sub.ends_with('.'))
}

#[cfg(test)]
mod tests {
    use super::allow_in_webview;

    #[test]
    fn allows_bundled_ui_and_local_schemes() {
        assert!(allow_in_webview("tauri", Some("localhost")));
        assert!(allow_in_webview("about", None));
        assert!(allow_in_webview("data", None));
        assert!(allow_in_webview("blob", Some("tauri.localhost")));
        assert!(allow_in_webview("http", Some("tauri.localhost")));
        assert!(allow_in_webview("https", Some("tauri.localhost")));
        assert!(allow_in_webview("http", Some("localhost")));
        assert!(allow_in_webview("http", Some("127.0.0.1")));
    }

    #[test]
    fn allows_boat_desktop_and_preview_subdomains_over_https() {
        assert!(allow_in_webview("https", Some("box-node-e3773ade05a75c39-desktop.on.boat.dev")));
        assert!(allow_in_webview("https", Some("dk123456-3000.on.boat.dev")));
        assert!(allow_in_webview("HTTPS", Some("BOX-DESKTOP.ON.BOAT.DEV")));
    }

    #[test]
    fn rejects_external_and_malformed_urls() {
        assert!(!allow_in_webview("http", Some("box-node-e3773ade05a75c39-desktop.on.boat.dev")));
        assert!(!allow_in_webview("https", Some("on.boat.dev")));
        assert!(!allow_in_webview("https", Some(".on.boat.dev")));
        assert!(!allow_in_webview("https", Some("foo..on.boat.dev")));
        assert!(!allow_in_webview("https", Some("evil-on.boat.dev")));
        assert!(!allow_in_webview("https", Some("on.boat.dev.evil.com")));
        assert!(!allow_in_webview("https", Some("boat.dev")));
        assert!(!allow_in_webview("https", Some("docs.boat.dev")));
        assert!(!allow_in_webview("https", Some("github.com")));
        assert!(!allow_in_webview("https", None));
    }
}
