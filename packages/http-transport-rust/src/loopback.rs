//! Where an application with no web page of its own is sent back to after a
//! sign-in at the issuer: a listener on this machine's loopback address, at
//! a port the system chose. The application gives `redirect_uri` to
//! `begin_authorization`, sends the person to the issuer, and waits on
//! `callback` for the URL they came back to.
//!
//! The issuer sends a person back only to an address its registration of
//! the client lists. The realm a Semiont launcher renders lists the loopback
//! address for the browser client with no port, which admits any port
//! (RFC 8252 §7.3).

use std::io;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const PATH: &str = "/callback";
/// A request line and its headers are read up to this many bytes.
const REQUEST_LIMIT: usize = 16 * 1024;

pub struct LoopbackRedirect {
    listener: TcpListener,
    origin: String,
}

impl LoopbackRedirect {
    /// Listen on the loopback address, at a port the system chooses.
    pub async fn bind() -> io::Result<LoopbackRedirect> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let origin = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
        Ok(LoopbackRedirect { listener, origin })
    }

    /// The address to have the issuer send the person back to.
    pub fn redirect_uri(&self) -> String {
        format!("{}{PATH}", self.origin)
    }

    /// Wait for the person to be sent back, tell their browser so, and give
    /// the URL they arrived at: what `complete_authorization` takes. A
    /// request for anything else is answered as not found and waited past.
    pub async fn callback(self) -> io::Result<String> {
        loop {
            let (mut stream, _) = self.listener.accept().await?;
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n")
                && request.len() < REQUEST_LIMIT
            {
                match stream.read(&mut chunk).await? {
                    0 => break,
                    read => request.extend_from_slice(&chunk[..read]),
                }
            }
            let line = String::from_utf8_lossy(&request);
            let target = line
                .lines()
                .next()
                .and_then(|line| line.strip_prefix("GET "))
                .and_then(|rest| rest.split(' ').next())
                .filter(|target| {
                    target
                        .strip_prefix(PATH)
                        .is_some_and(|rest| rest.is_empty() || rest.starts_with('?'))
                })
                .map(str::to_owned);
            let (status, body) = match &target {
                Some(_) => ("200 OK", "You are signed in. You can close this window."),
                None => ("404 Not Found", "Not found."),
            };
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await?;
            stream.shutdown().await?;
            if let Some(target) = target {
                return Ok(format!("{}{target}", self.origin));
            }
        }
    }
}
