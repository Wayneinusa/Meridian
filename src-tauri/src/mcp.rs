//! Local MCP servers: a child process that speaks JSON-RPC, one message per
//! line, on stdin/stdout. The web view sends lines in and gets each line the
//! server prints back as an `mcp-stdio` event. Desktop only.

use std::collections::HashMap;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

#[cfg(desktop)]
pub struct Proc {
    stdin: tokio::process::ChildStdin,
    child: tokio::process::Child,
}
#[cfg(mobile)]
pub struct Proc;

#[derive(Default)]
pub struct McpState(pub Mutex<HashMap<String, Proc>>);

#[cfg(desktop)]
#[tauri::command]
pub async fn mcp_stdio_start(
    app: AppHandle,
    state: State<'_, McpState>,
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<(), String> {
    use std::{process::Stdio, sync::Arc};
    use tauri::Emitter;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, BufReader},
        process::Command,
    };

    if let Some(mut old) = state.0.lock().await.remove(&id) {
        let _ = old.child.kill().await;
    }

    let mut cmd;
    #[cfg(windows)]
    {
        // npx, uvx and friends are .cmd shims on Windows, which only cmd.exe can launch
        cmd = Command::new("cmd.exe");
        cmd.arg("/C").arg(&command).args(&args);
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        cmd = Command::new(&command);
        cmd.args(&args);
    }
    cmd.envs(&env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("could not start \"{command}\": {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;

    // keep the tail of stderr so a crash can be explained to the user
    let err_tail = Arc::new(Mutex::new(String::new()));
    let err_sink = err_tail.clone();
    tokio::spawn(async move {
        let mut buf = [0u8; 2048];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut tail = err_sink.lock().await;
            tail.push_str(&String::from_utf8_lossy(&buf[..n]));
            if tail.len() > 4000 {
                let mut cut = tail.len() - 4000;
                while !tail.is_char_boundary(cut) {
                    cut += 1;
                }
                *tail = tail[cut..].to_string();
            }
        }
    });

    let event_id = id.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let _ = app.emit("mcp-stdio", serde_json::json!({ "id": event_id, "line": line }));
        }
        let stderr = err_tail.lock().await.clone();
        let _ = app.emit("mcp-stdio", serde_json::json!({ "id": event_id, "closed": true, "stderr": stderr }));
    });

    state.0.lock().await.insert(id, Proc { stdin, child });
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn mcp_stdio_send(state: State<'_, McpState>, id: String, line: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut procs = state.0.lock().await;
    let proc = procs.get_mut(&id).ok_or("the connector process is not running")?;
    proc.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    proc.stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    proc.stdin.flush().await.map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn mcp_stdio_stop(state: State<'_, McpState>, id: String) -> Result<(), String> {
    if let Some(mut proc) = state.0.lock().await.remove(&id) {
        let _ = proc.child.kill().await;
    }
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn mcp_stdio_start(
    _app: AppHandle,
    _state: State<'_, McpState>,
    _id: String,
    _command: String,
    _args: Vec<String>,
    _env: HashMap<String, String>,
) -> Result<(), String> {
    Err("Local command connectors only run in the desktop app.".into())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn mcp_stdio_send(_state: State<'_, McpState>, _id: String, _line: String) -> Result<(), String> {
    Err("Local command connectors only run in the desktop app.".into())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn mcp_stdio_stop(_state: State<'_, McpState>, _id: String) -> Result<(), String> {
    Ok(())
}
