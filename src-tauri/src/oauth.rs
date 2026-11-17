//! Sign-in redirects for connectors on desktop: a one-shot web server on
//! 127.0.0.1 that receives the browser's redirect after the user signs in
//! (RFC 8252 loopback redirect). iOS uses the meridian:// URL scheme instead.

use std::{collections::HashMap, sync::Mutex};
use tauri::State;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

#[derive(Default)]
pub struct OAuthState(pub Mutex<HashMap<u16, oneshot::Receiver<String>>>);

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>Signed in</title><body style=\"font:16px -apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:90vh;color:#1e1d1a\"><div style=\"text-align:center\"><h2>You're signed in</h2><p>You can close this tab and return to Meridian.</p></div>";

/// Start listening; returns the port. The redirect URI is http://127.0.0.1:<port>/callback
#[tauri::command]
pub async fn oauth_listen(state: State<'_, OAuthState>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (tx, rx) = oneshot::channel::<String>();
    state.0.lock().map_err(|e| e.to_string())?.insert(port, rx);
    tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(600);
        loop {
            let accepted = tokio::time::timeout_at(deadline, listener.accept()).await;
            let Ok(Ok((mut sock, _))) = accepted else { return };
            let mut buf = vec![0u8; 8192];
            let n = match tokio::time::timeout(std::time::Duration::from_secs(10), sock.read(&mut buf)).await {
                Ok(Ok(n)) => n,
                _ => continue,
            };
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/").to_string();
            if !path.starts_with("/callback") {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", PAGE.len(), PAGE);
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
            let _ = tx.send(format!("http://127.0.0.1:{port}{path}"));
            return;
        }
    });
    Ok(port)
}

/// Wait for the browser to come back; returns the full redirect URL.
#[tauri::command]
pub async fn oauth_wait(state: State<'_, OAuthState>, port: u16) -> Result<String, String> {
    let rx = state.0.lock().map_err(|e| e.to_string())?.remove(&port).ok_or("no sign-in is waiting on that port")?;
    match tokio::time::timeout(std::time::Duration::from_secs(600), rx).await {
        Ok(Ok(url)) => Ok(url),
        Ok(Err(_)) => Err("The sign-in window was closed before it finished.".into()),
        Err(_) => Err("Sign-in timed out after 10 minutes.".into()),
    }
}
