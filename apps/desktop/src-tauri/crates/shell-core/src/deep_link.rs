//! The `dorks://` links the desktop app opens (docs/desktop.md, "Links").
//!
//! macOS hands the app every `dorks://` URL it is registered for (`tauri-plugin-deep-link`): an invitation email's
//! `dorks://invite/<id>`, and a phone pairing code's `dorks://pair?code=...` opened on the Mac by mistake. Each maps to a route of
//! the bundled UI (its hash router), or to nothing: a link never carries anything else into the app.

/// The UI route for a `dorks://` URL, or `None` for anything this app does not open.
///
/// - `dorks://invite/<id>` opens the invitation (`/invite/<id>`): Join or Decline.
/// - `dorks://pair?...` is for the phone to scan; on the Mac it opens Settings, Phone (`/settings/phone`), where pairing lives.
pub fn route_for(url: &str) -> Option<String> {
    let rest = strip_scheme(url.trim())?;
    // `dorks://invite/abc?x#y`: the host is the action, the path its argument; query and fragment only matter for pairing.
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    let (target, _) = rest.split_at(end);
    let mut parts = target.split('/');
    let action = parts.next()?.to_ascii_lowercase();
    let args: Vec<&str> = parts.filter(|p| !p.is_empty()).collect();
    match (action.as_str(), args.as_slice()) {
        ("invite", [id]) if valid_id(id) => Some(format!("/invite/{id}")),
        ("pair", []) => Some("/settings/phone".to_string()),
        _ => None,
    }
}

fn strip_scheme(url: &str) -> Option<&str> {
    let (scheme, rest) = url.split_once("://")?;
    scheme.eq_ignore_ascii_case("dorks").then_some(rest)
}

/// Invitation ids are Better Auth's: letters, digits, `-` and `_`. Anything else (an encoded slash, a dot) is refused.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::route_for;

    #[test]
    fn opens_an_invitation() {
        assert_eq!(route_for("dorks://invite/inv_8Kd2-x").as_deref(), Some("/invite/inv_8Kd2-x"));
        assert_eq!(route_for("DORKS://Invite/abc/").as_deref(), Some("/invite/abc"));
        assert_eq!(route_for(" dorks://invite/abc?utm=mail#top ").as_deref(), Some("/invite/abc"));
    }

    #[test]
    fn sends_a_pairing_code_to_the_phone_settings() {
        assert_eq!(route_for("dorks://pair?code=ABCD2345&cloud=https%3A%2F%2Fapi.dorks.build").as_deref(), Some("/settings/phone"));
        assert_eq!(route_for("dorks://pair").as_deref(), Some("/settings/phone"));
    }

    #[test]
    fn opens_nothing_else() {
        for url in [
            "dorks://invite/",
            "dorks://invite",
            "dorks://invite/a/b",
            "dorks://invite/..",
            "dorks://invite/a%2Fb",
            "dorks://invite/<script>",
            "dorks://settings/phone",
            "dorks://",
            "https://dorks.build/invite/abc",
            "dorksx://invite/abc",
            "invite/abc",
        ] {
            assert_eq!(route_for(url), None, "{url}");
        }
    }
}
