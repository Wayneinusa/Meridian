//! Shell commands and "open with default app". Desktop only.

use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
pub struct CommandResult {
    stdout: String,
    stderr: String,
    code: Option<i32>,
    timed_out: bool,
}

#[cfg(desktop)]
#[tauri::command]
pub async fn run_command(app: AppHandle, command: String, cwd: Option<String>, timeout_ms: u64) -> Result<CommandResult, String> {
    use std::{process::Stdio, time::Duration};
    use tauri::Manager;
    use tokio::{io::AsyncReadExt, process::Command};

    let mut cmd;
    #[cfg(windows)]
    {
        cmd = Command::new("powershell.exe");
        // UTF-8 output regardless of the console code page
        let script = format!("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; {command}");
        cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script]);
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        cmd = Command::new("sh");
        cmd.args(["-c", &command]);
    }

    let dir = cwd
        .filter(|d| !d.trim().is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| app.path().home_dir().ok());
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("could not start the shell: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    });
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    let limit = Duration::from_millis(timeout_ms.clamp(1_000, 1_800_000));
    let (code, timed_out) = match tokio::time::timeout(limit, child.wait()).await {
        Ok(status) => (status.map_err(|e| e.to_string())?.code(), false),
        Err(_) => {
            let _ = child.kill().await;
            (None, true)
        }
    };
    // After a kill, grandchildren can keep the pipes open; do not wait on them forever.
    let grab = |task: tokio::task::JoinHandle<Vec<u8>>| async move {
        match tokio::time::timeout(Duration::from_secs(3), task).await {
            Ok(Ok(buf)) => String::from_utf8_lossy(&buf).into_owned(),
            _ => String::new(),
        }
    };
    Ok(CommandResult { stdout: grab(out_task).await, stderr: grab(err_task).await, code, timed_out })
}

#[cfg(mobile)]
#[tauri::command]
pub async fn run_command(_app: AppHandle, _command: String, _cwd: Option<String>, _timeout_ms: u64) -> Result<CommandResult, String> {
    Err("Running commands is not possible on this device.".into())
}

/// Open a URL, file or folder the way double-clicking it would.
#[tauri::command(async)]
pub fn open_target(app: AppHandle, target: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let t = target.trim();
    let is_url = t.starts_with("http://") || t.starts_with("https://") || t.starts_with("mailto:");
    let result = if is_url { app.opener().open_url(t, None::<&str>) } else { app.opener().open_path(t, None::<&str>) };
    result.map_err(|e| format!("could not open {t}: {e}"))
}
