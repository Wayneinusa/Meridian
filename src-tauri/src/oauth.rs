//! Sign-in redirects for connectors and Grok on desktop: a one-shot web server
//! on 127.0.0.1 that receives the browser's redirect after the user signs in
//! (RFC 8252 loopback redirect). iOS uses the meridian:// URL scheme instead.
//!
//! Some sign-in pages (xAI's) do not redirect: their page script hands the code
//! to the loopback address with fetch(). Browsers only allow that from a public
//! https page to 127.0.0.1 after a CORS / Private Network Access preflight, so
//! OPTIONS is answered with those headers and the code may arrive as a GET
//! query or a POST body (form or JSON).

use std::{collections::HashMap, sync::Mutex};
use tauri::State;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
    task::JoinHandle,
};

#[derive(Default)]
pub struct OAuthState {
    waiting: Mutex<HashMap<u16, oneshot::Receiver<String>>>,
    servers: Mutex<HashMap<u16, JoinHandle<()>>>,
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>Signed in</title><body style=\"font:16px -apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:90vh;color:#1e1d1a\"><div style=\"text-align:center\"><h2>You're signed in</h2><p>You can close this tab and return to Meridian.</p></div>";

fn header<'a>(req: &'a str, name: &str) -> Option<&'a str> {
    req.lines()
        .take_while(|l| !l.is_empty())
        .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case(name)).map(|(_, v)| v.trim()))
}

/// CORS and Private Network Access headers, echoing the page's origin.
fn cors(req: &str) -> String {
    let origin = header(req, "origin").unwrap_or("*");
    format!(
        "Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Private-Network: true\r\nVary: Origin\r\n"
    )
}

/// `code` and `state` from a POST body (form-encoded or JSON), as a query string.
fn query_from_body(body: &str) -> String {
    let b = body.trim();
    if b.starts_with('{') {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(b) {
            let mut pairs = Vec::new();
            for key in ["code", "state", "error", "error_description"] {
                if let Some(v) = map.get(key).and_then(|v| v.as_str()) {
                    let enc: String = v.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") }).collect();
                    pairs.push(format!("{key}={enc}"));
                }
            }
            return pairs.join("&");
        }
    }
    b.to_string()
}

/// Answer requests until the code arrives (or 10 minutes pass), then hand it over.
async fn serve(listener: TcpListener, port: u16, tx: oneshot::Sender<String>) {
    let mut tx = Some(tx);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(600);
    loop {
        let accepted = tokio::time::timeout_at(deadline, listener.accept()).await;
        let Ok(Ok((mut sock, _))) = accepted else { return };
        let mut buf = vec![0u8; 16384];
        let n = match tokio::time::timeout(std::time::Duration::from_secs(10), sock.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => continue,
        };
        let mut got = n;
        // a POST body may arrive after the headers: read until Content-Length is met
        while let Some(end) = buf[..got].windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_string();
            let want = header(&head, "content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
            if got >= end + 4 + want || got == buf.len() {
                break;
            }
            match tokio::time::timeout(std::time::Duration::from_secs(10), sock.read(&mut buf[got..])).await {
                Ok(Ok(m)) if m > 0 => got += m,
                _ => break,
            }
        }
        let req = String::from_utf8_lossy(&buf[..got]).to_string();
        let mut words = req.lines().next().unwrap_or("").split_whitespace();
        let method = words.next().unwrap_or("GET").to_string();
        let path = words.next().unwrap_or("/").to_string();
        let cors = cors(&req);
        if method == "OPTIONS" {
            let _ = sock.write_all(format!("HTTP/1.1 204 No Content\r\n{cors}Content-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await;
            continue;
        }
        if !path.starts_with("/callback") {
            let _ = sock.write_all(format!("HTTP/1.1 404 Not Found\r\n{cors}Content-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await;
            continue;
        }
        let query = if method == "POST" {
            let body = req.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
            format!("?{}", query_from_body(body))
        } else {
            path.find('?').map(|i| path[i..].to_string()).unwrap_or_default()
        };
        let resp = format!("HTTP/1.1 200 OK\r\n{cors}Content-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", PAGE.len(), PAGE);
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.flush().await;
        if let Some(tx) = tx.take() {
            let _ = tx.send(format!("http://127.0.0.1:{port}/callback{query}"));
        }
        return;
    }
}

/// Start listening; returns the port. The redirect URI is http://127.0.0.1:<port>/callback
/// `port` pins the port for services that only accept one fixed redirect (xAI uses 56121).
#[tauri::command]
pub async fn oauth_listen(state: State<'_, OAuthState>, port: Option<u16>) -> Result<u16, String> {
    // a pinned port may still be held by an earlier attempt of ours: free it
    if let Some(p) = port {
        // take the handle out first: a lock guard must not be held across the await
        let old = state.servers.lock().map_err(|e| e.to_string())?.remove(&p);
        state.waiting.lock().map_err(|e| e.to_string())?.remove(&p);
        if let Some(old) = old {
            old.abort();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", port.unwrap_or(0)))
        .await
        .map_err(|e| if port.is_some() { format!("port {} is in use (is another Grok app signing in?): {e}", port.unwrap_or(0)) } else { e.to_string() })?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (tx, rx) = oneshot::channel::<String>();
    state.waiting.lock().map_err(|e| e.to_string())?.insert(port, rx);
    let task = tokio::spawn(serve(listener, port, tx));
    state.servers.lock().map_err(|e| e.to_string())?.insert(port, task);
    Ok(port)
}

/// Wait for the browser to come back; returns the full redirect URL.
#[tauri::command]
pub async fn oauth_wait(state: State<'_, OAuthState>, port: u16) -> Result<String, String> {
    let rx = { state.waiting.lock().map_err(|e| e.to_string())?.remove(&port) }.ok_or("no sign-in is waiting on that port")?;
    let result = match tokio::time::timeout(std::time::Duration::from_secs(600), rx).await {
        Ok(Ok(url)) => Ok(url),
        Ok(Err(_)) => Err("The sign-in was cancelled.".into()),
        Err(_) => Err("Sign-in timed out after 10 minutes.".into()),
    };
    state.servers.lock().map_err(|e| e.to_string())?.remove(&port);
    result
}

/// Stop listening (the user pasted the code instead, or cancelled).
#[tauri::command]
pub fn oauth_cancel(state: State<'_, OAuthState>, port: u16) -> Result<(), String> {
    if let Some(task) = state.servers.lock().map_err(|e| e.to_string())?.remove(&port) {
        task.abort();
    }
    state.waiting.lock().map_err(|e| e.to_string())?.remove(&port);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn send(port: u16, raw: &str) -> String {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(raw.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    #[test]
    fn body_to_query() {
        assert_eq!(query_from_body(r#"{"code":"a b/c","state":"s1","other":1}"#), "code=a%20b%2Fc&state=s1");
        assert_eq!(query_from_body("code=x&state=y"), "code=x&state=y");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn page_script_handoff_is_allowed_and_received() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel();
        let server = tokio::spawn(serve(listener, port, tx));
        // the browser's Private Network Access / CORS preflight from auth.x.ai
        let pre = send(port, "OPTIONS /callback HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://auth.x.ai\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Private-Network: true\r\n\r\n").await;
        assert!(pre.starts_with("HTTP/1.1 204"), "{pre}");
        assert!(pre.contains("Access-Control-Allow-Origin: https://auth.x.ai"));
        assert!(pre.contains("Access-Control-Allow-Private-Network: true"));
        // a stray request does not end the sign-in
        assert!(send(port, "GET /favicon.ico HTTP/1.1\r\n\r\n").await.starts_with("HTTP/1.1 404"));
        let body = r#"{"code":"CODE1","state":"ST"}"#;
        let ok = send(port, &format!("POST /callback HTTP/1.1\r\nOrigin: https://auth.x.ai\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())).await;
        assert!(ok.starts_with("HTTP/1.1 200") && ok.contains("Access-Control-Allow-Origin: https://auth.x.ai"));
        assert_eq!(rx.await.unwrap(), format!("http://127.0.0.1:{port}/callback?code=CODE1&state=ST"));
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn body_sent_after_the_headers() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel();
        tokio::spawn(serve(listener, port, tx));
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(b"POST /callback HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 15\r\n\r\n").await.unwrap();
        s.flush().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        s.write_all(b"code=K9&state=W").await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 200"));
        assert_eq!(rx.await.unwrap(), format!("http://127.0.0.1:{port}/callback?code=K9&state=W"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn plain_redirect_still_works() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel();
        tokio::spawn(serve(listener, port, tx));
        let ok = send(port, "GET /callback?code=Z&state=Q HTTP/1.1\r\n\r\n").await;
        assert!(ok.contains("You're signed in"));
        assert_eq!(rx.await.unwrap(), format!("http://127.0.0.1:{port}/callback?code=Z&state=Q"));
    }
}
