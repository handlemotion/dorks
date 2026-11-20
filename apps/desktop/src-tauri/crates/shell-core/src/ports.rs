//! Port picking for the sidecar's two listeners.

use std::io;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};

/// Returns `preferred` if it can be bound on loopback right now, else a free port chosen by the OS. Never returns a port in
/// `exclude`. The port is released before returning, so another process could still grab it; the supervisor treats a server
/// that cannot bind as a failed start and retries.
pub fn pick_port(preferred: Option<u16>, exclude: &[u16]) -> io::Result<u16> {
    if let Some(port) = preferred.filter(|p| *p != 0 && !exclude.contains(p)) {
        if TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok() {
            return Ok(port);
        }
    }
    for _ in 0..32 {
        let port = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?.local_addr()?.port();
        if !exclude.contains(&port) {
            return Ok(port);
        }
    }
    Err(io::Error::new(io::ErrorKind::AddrNotAvailable, "no free port"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_a_free_preferred_port() {
        let free = pick_port(None, &[]).unwrap();
        assert_eq!(pick_port(Some(free), &[]).unwrap(), free);
    }

    #[test]
    fn falls_back_when_busy_or_excluded() {
        let held = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let busy = held.local_addr().unwrap().port();
        let picked = pick_port(Some(busy), &[]).unwrap();
        assert_ne!(picked, busy);
        let free = pick_port(None, &[]).unwrap();
        assert_ne!(pick_port(Some(free), &[free]).unwrap(), free);
    }
}
