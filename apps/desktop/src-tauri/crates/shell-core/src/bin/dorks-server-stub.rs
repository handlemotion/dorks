//! Stand-in for `dorks-server` (apps/server) so the shell's supervision can be built and tested before the real server exists.
//! It implements the contract in `contract.rs` and nothing else. Standard library only.
//!
//! Extra behaviour for tests, driven by env vars the real server does not know:
//! - `STUB_STARTUP_DELAY_MS`: wait before listening.
//! - `STUB_EXIT_CODE`: exit with this code right after start (crash loop).
//!
//! Endpoints on the UI port: `/api/health`, `/api/ping` (needs `Authorization: Bearer <owner token>`), `/crash` (exit 1),
//! `/sick` (from now on `/api/health` answers 503), `/env` (which contract variables are set; never values of secrets).

use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

static TERMINATED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_term(_: libc::c_int) {
    TERMINATED.store(true, Ordering::SeqCst);
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn port(name: &str) -> u16 {
    env(name).and_then(|v| v.parse().ok()).unwrap_or_else(|| {
        eprintln!("stub: {name} is required");
        std::process::exit(2);
    })
}

fn main() {
    // SAFETY: installing an async-signal-safe handler that only stores to an atomic.
    unsafe {
        libc::signal(libc::SIGTERM, on_term as extern "C" fn(libc::c_int) as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_term as extern "C" fn(libc::c_int) as libc::sighandler_t);
    }
    let ui_port = port("DORKS_UI_PORT");
    let bridge_port = port("DORKS_BRIDGE_PORT");
    let token = env("DORKS_OWNER_TOKEN").unwrap_or_else(|| {
        eprintln!("stub: DORKS_OWNER_TOKEN is required");
        std::process::exit(2);
    });
    let data_dir = env("DORKS_DATA_DIR").unwrap_or_else(|| {
        eprintln!("stub: DORKS_DATA_DIR is required");
        std::process::exit(2);
    });
    if let Some(ms) = env("STUB_STARTUP_DELAY_MS").and_then(|v| v.parse().ok()) {
        thread::sleep(Duration::from_millis(ms));
    }
    if let Some(code) = env("STUB_EXIT_CODE").and_then(|v| v.parse::<i32>().ok()) {
        eprintln!("stub: exiting with {code}");
        std::process::exit(code);
    }
    // Proves the data dir is usable, like a database would.
    std::fs::write(std::path::Path::new(&data_dir).join("stub.db"), b"stub").expect("data dir is writable");

    let sick = Arc::new(AtomicBool::new(false));
    let public_url_set = env("DORKS_PUBLIC_URL").is_some();
    let ui = TcpListener::bind((Ipv4Addr::LOCALHOST, ui_port)).expect("bind ui port");
    let bridge = TcpListener::bind((Ipv4Addr::LOCALHOST, bridge_port)).expect("bind bridge port");
    println!("stub: listening ui={ui_port} bridge={bridge_port}");

    if let Some(parent) = env("DORKS_PARENT_PID").and_then(|v| v.parse::<i32>().ok()) {
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(500));
            // SAFETY: signal 0 only checks that the process exists.
            if unsafe { libc::kill(parent, 0) } != 0 {
                eprintln!("stub: parent {parent} is gone, exiting");
                std::process::exit(0);
            }
        });
    }

    {
        let sick = sick.clone();
        thread::spawn(move || {
            for stream in ui.incoming().flatten() {
                let sick = sick.clone();
                let token = token.clone();
                thread::spawn(move || ui_request(stream, &sick, &token, bridge_port, public_url_set));
            }
        });
    }
    thread::spawn(move || {
        for mut stream in bridge.incoming().flatten() {
            let _ = read_head(&mut stream);
            respond(&mut stream, 200, "bridge");
        }
    });

    while !TERMINATED.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(50));
    }
    println!("stub: terminated cleanly");
}

fn read_head(stream: &mut TcpStream) -> String {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut head = Vec::new();
    let mut buf = [0u8; 512];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < 8192 {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    String::from_utf8_lossy(&head).into_owned()
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Service Unavailable",
    };
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n{body}", body.len());
}

fn ui_request(mut stream: TcpStream, sick: &AtomicBool, token: &str, bridge_port: u16, public_url_set: bool) {
    let head = read_head(&mut stream);
    let path = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
    match path {
        "/api/health" if sick.load(Ordering::SeqCst) => respond(&mut stream, 503, "sick"),
        "/api/health" => respond(&mut stream, 200, "ok"),
        "/sick" => {
            sick.store(true, Ordering::SeqCst);
            respond(&mut stream, 200, "now sick");
        }
        "/crash" => std::process::exit(1),
        "/api/ping" => {
            let expected = format!("bearer {token}");
            let authorised = head.lines().any(|l| l.to_ascii_lowercase().strip_prefix("authorization:").is_some_and(|v| v.trim() == expected.to_ascii_lowercase()));
            if authorised {
                respond(&mut stream, 200, "pong");
            } else {
                respond(&mut stream, 401, "no");
            }
        }
        "/env" => respond(&mut stream, 200, &format!("{{\"bridgePort\":{bridge_port},\"publicUrlSet\":{public_url_set},\"parentPidSet\":{}}}", env("DORKS_PARENT_PID").is_some())),
        _ => respond(&mut stream, 404, "not found"),
    }
}
