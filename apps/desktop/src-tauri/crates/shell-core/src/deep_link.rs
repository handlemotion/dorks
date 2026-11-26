//! The `dorks://` links the desktop app opens (docs/desktop.md, "Links").
//!
//! macOS hands the app every `dorks://` URL it is registered for (`tauri-plugin-deep-link`): an invitation email's
//! `dorks://invite/<id>`, the website's `dorks://auth?code=...&state=...` after a Dorks Cloud sign-in, and a phone pairing code's
//! `dorks://pair?code=...` opened on the Mac by mistake. Each maps to a route of
//! the bundled UI (its hash router), or to nothing: a link never carries anything else into the app.

/// The UI route for a `dorks://` URL, or `None` for anything this app does not open.
///
/// - `dorks://invite/<id>` opens the invitation (`/invite/<id>`): Join or Decline.
/// - `dorks://pair?...` is for the phone to scan; on the Mac it opens Settings, Phone (`/settings/phone`), where pairing lives.
/// - `dorks://auth?code=<code>&state=<state>` finishes a Dorks Cloud sign-in started in the browser (`/auth?code=...&state=...`): the
///   UI hands both to the local server, which checks the state is one it opened and redeems the code.
/// - `dorks://github?from=<settings|new>&github=connected` ends a cloud org's GitHub App install (Dorks Cloud's callback page opens
///   it): back to where it started, Settings › Organization (`/settings/organization`) or a new session (`/dorks`). Nothing else
///   in it is carried; the UI reads the connection again when the window comes to the front.
pub fn route_for(url: &str) -> Option<String> {
    let rest = strip_scheme(url.trim())?;
    // `dorks://invite/abc?x#y`: the host is the action, the path its argument; the query only matters for a sign-in.
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    let (target, tail) = rest.split_at(end);
    let query = tail.strip_prefix('?').map(|q| q.split('#').next().unwrap_or(""));
    let mut parts = target.split('/');
    let action = parts.next()?.to_ascii_lowercase();
    let args: Vec<&str> = parts.filter(|p| !p.is_empty()).collect();
    match (action.as_str(), args.as_slice()) {
        ("invite", [id]) if valid_id(id) => Some(format!("/invite/{id}")),
        ("pair", []) => Some("/settings/phone".to_string()),
        ("github", []) => Some(if query.and_then(|q| param(q, "from")) == Some("settings") { "/settings/organization" } else { "/dorks" }.to_string()),
        ("auth", []) => {
            let (code, state) = (param(query?, "code")?, param(query?, "state")?);
            Some(format!("/auth?code={code}&state={state}"))
        }
        _ => None,
    }
}

/// One query parameter that must be a plain token (letters, digits, `-`, `_`; at most 256): the sign-in's code or state.
fn param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    let value = query.split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('='))?;
    (!value.is_empty() && value.len() <= 256 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then_some(value)
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
        assert_eq!(route_for("dorks://github?from=settings&github=connected&account=acme").as_deref(), Some("/settings/organization"));
        assert_eq!(route_for("dorks://github?from=new&github=connected").as_deref(), Some("/dorks"));
        assert_eq!(route_for("dorks://github").as_deref(), Some("/dorks"));
        assert_eq!(route_for("dorks://github/../settings?from=settings").as_deref(), None);
    }

    #[test]
    fn finishes_a_cloud_sign_in() {
        assert_eq!(route_for("dorks://auth?code=Ab3_x-9&state=s7Kq_2").as_deref(), Some("/auth?code=Ab3_x-9&state=s7Kq_2"));
        assert_eq!(route_for("dorks://auth/?state=s7Kq&code=c0de&utm=x#top").as_deref(), Some("/auth?code=c0de&state=s7Kq"));
        for url in ["dorks://auth", "dorks://auth?code=abc", "dorks://auth?state=abc", "dorks://auth?code=&state=abc", "dorks://auth?code=a%26b&state=s", "dorks://auth?code=a&state=s/x", "dorks://auth/x?code=a&state=s"] {
            assert_eq!(route_for(url), None, "{url}");
        }
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
