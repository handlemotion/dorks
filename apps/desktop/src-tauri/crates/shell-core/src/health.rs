//! Minimal HTTP/1.1 GET against the sidecar's loopback port, so the shell needs no HTTP client dependency.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Status code of `GET http://127.0.0.1:{port}{path}`, or an error if nothing answers within `limit`.
pub async fn http_status(port: u16, path: &str, limit: Duration) -> io::Result<u16> {
    timeout(limit, async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
        let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: */*\r\n\r\n");
        stream.write_all(request.as_bytes()).await?;
        let mut head = Vec::with_capacity(256);
        let mut buf = [0u8; 256];
        while head.len() < 4096 && !head.windows(2).any(|w| w == b"\r\n") {
            let n = stream.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            head.extend_from_slice(&buf[..n]);
        }
        parse_status_line(&head).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no HTTP status line"))
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "health check timed out"))?
}

pub async fn is_healthy(port: u16, path: &str, limit: Duration) -> bool {
    matches!(http_status(port, path, limit).await, Ok(200))
}

fn parse_status_line(head: &[u8]) -> Option<u16> {
    let line = std::str::from_utf8(head).ok()?.lines().next()?;
    let mut parts = line.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    async fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 512];
            let _ = s.read(&mut buf).await;
            s.write_all(response.as_bytes()).await.unwrap();
        });
        port
    }

    #[tokio::test]
    async fn reads_the_status_code() {
        let port = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await;
        assert!(is_healthy(port, "/api/health", Duration::from_secs(2)).await);
        let port = serve_once("HTTP/1.1 503 Service Unavailable\r\n\r\n").await;
        assert_eq!(http_status(port, "/api/health", Duration::from_secs(2)).await.unwrap(), 503);
    }

    #[tokio::test]
    async fn nothing_listening_is_unhealthy() {
        let port = crate::ports::pick_port(None, &[]).unwrap();
        assert!(!is_healthy(port, "/api/health", Duration::from_millis(300)).await);
    }

    #[test]
    fn status_line_parsing() {
        assert_eq!(parse_status_line(b"HTTP/1.1 204 No Content\r\n"), Some(204));
        assert_eq!(parse_status_line(b"garbage"), None);
    }
}
