//! The shell <-> `dorks-server` contract, in one place so the server (apps/server) and the shell can agree on it by editing
//! only this file and `docs/desktop.md`.
//!
//! The server is started with no arguments and everything below in its environment. It must:
//! - listen on `127.0.0.1:$DORKS_UI_PORT` (UI + API, loopback only) and answer `GET /api/health` with 200 once it is ready;
//! - keep all state under `$DORKS_DATA_DIR`;
//! - require `$DORKS_OWNER_TOKEN` for UI/API calls;
//! - exit cleanly on SIGTERM, and (optional, recommended) exit by itself if `$DORKS_PARENT_PID` disappears. The shell also
//!   reaps an orphaned server from its pid file on the next start, so this is belt and braces.
//!
//! Matches docs/architecture.md (apps/server): `GET /api/health` is unauthenticated. The server dials out to each sandbox's
//! bridge, so it opens no other listener.

/// Directory for all of the server's state (SQLite file, logs). Created by the shell.
pub const ENV_DATA_DIR: &str = "DORKS_DATA_DIR";
/// Secret the UI presents to the API. Generated on first run, stored 0600, never logged.
pub const ENV_OWNER_TOKEN: &str = "DORKS_OWNER_TOKEN";
/// Loopback port for the UI and API.
pub const ENV_UI_PORT: &str = "DORKS_UI_PORT";
/// PID of the shell. A server that sees this process gone should exit.
pub const ENV_PARENT_PID: &str = "DORKS_PARENT_PID";

/// Path polled until it answers 200.
pub const HEALTH_PATH: &str = "/api/health";

/// Port the server uses by default; the shell tries it first so the URL stays stable, and falls back to a free port.
pub const DEFAULT_UI_PORT: u16 = 4747;

/// Name of the sidecar executable (without target triple).
pub const SERVER_BIN_NAME: &str = "dorks-server";
/// Overrides the sidecar path (development).
pub const ENV_SERVER_BIN: &str = "DORKS_SERVER_BIN";
/// The Boat CLI bundled with the app (externalBin `boat`), handed to the server as `DORKS_BOAT_BIN`: it connects Boat with the
/// owner's Boat login when no `boat` is on PATH (apps/server/src/lib/boatCli.ts).
pub const BOAT_BIN_NAME: &str = "boat";
pub const ENV_BOAT_BIN: &str = "DORKS_BOAT_BIN";

/// Shell-side only: overrides the app directory (default: `~/Library/Application Support/Dorks`). The server gets
/// `<app dir>/server` as `DORKS_DATA_DIR`.
pub const ENV_APP_DIR: &str = "DORKS_APP_DIR";
