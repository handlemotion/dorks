//! Platform-independent parts of the Dorks desktop shell. The Tauri glue lives in the parent crate.
//!
//! The shell supervises one sidecar, `dorks-server`, and talks to it only through the contract in [`contract`].

pub mod contract;
pub mod github;
pub mod health;
pub mod paths;
pub mod power;
pub mod ports;
pub mod secrets;
pub mod settings;
pub mod supervisor;
pub mod tunnel;
