//! The shell <-> `dorks-server` contract, in one place so the server (apps/server) and the shell can agree on it by editing
//! only this file and `docs/desktop.md`.
//!
//! The server is started with no arguments and everything below in its environment. It must:
//! - listen on `127.0.0.1:$DORKS_UI_PORT` (UI + API, loopback only) and answer `GET /api/health` with 200 once it is ready;
//! - listen on `$DORKS_BRIDGE_PORT` for sandbox bridges (the only port the tunnel exposes);
//! - keep all state under `$DORKS_DATA_DIR`;
//! - require `$DORKS_OWNER_TOKEN` for UI/API calls;
//! - exit cleanly on SIGTERM, and (optional, recommended) exit by itself if `$DORKS_PARENT_PID` disappears. The shell also
//!   reaps an orphaned server from its pid file on the next start, so this is belt and braces.
//!
//! Matches docs/architecture.md (apps/server): `GET /api/health` is unauthenticated, the bridge listener serves only `/bridge`.

/// Directory for all of the server's state (SQLite file, logs). Created by the shell.
pub const ENV_DATA_DIR: &str = "DORKS_DATA_DIR";
/// Secret the UI presents to the API. Generated on first run, stored 0600, never logged.
pub const ENV_OWNER_TOKEN: &str = "DORKS_OWNER_TOKEN";
/// Loopback port for the UI and API.
pub const ENV_UI_PORT: &str = "DORKS_UI_PORT";
/// Port for sandbox bridges; the tunnel forwards the public URL to this port.
pub const ENV_BRIDGE_PORT: &str = "DORKS_BRIDGE_PORT";
/// Public URL of the bridge port as sandboxes see it. Unset when no tunnel is available.
pub const ENV_PUBLIC_URL: &str = "DORKS_PUBLIC_URL";
/// PID of the shell. A server that sees this process gone should exit.
pub const ENV_PARENT_PID: &str = "DORKS_PARENT_PID";

/// Path polled until it answers 200.
pub const HEALTH_PATH: &str = "/api/health";

/// Ports the server uses by default; the shell tries these first so URLs stay stable, and falls back to free ports.
pub const DEFAULT_UI_PORT: u16 = 4747;
pub const DEFAULT_BRIDGE_PORT: u16 = 4748;

/// Name of the sidecar executable (without target triple).
pub const SERVER_BIN_NAME: &str = "dorks-server";
/// Overrides the sidecar path (development).
pub const ENV_SERVER_BIN: &str = "DORKS_SERVER_BIN";

/// Shell-side only: path of the wurmhol client executable (default: `wurmhol` next to the app, else on PATH plus the usual
/// Homebrew and `~/.local/bin` locations).
pub const ENV_WURMHOL_BIN: &str = "WURMHOL_BIN";

/// Shell-side only: overrides the app directory (default: `~/Library/Application Support/Dorks`). The server gets
/// `<app dir>/server` as `DORKS_DATA_DIR`.
pub const ENV_APP_DIR: &str = "DORKS_APP_DIR";
// A `DORKS_PUBLIC_URL` set in the shell's own environment overrides the tunnel (user-supplied URL) and is passed through.
