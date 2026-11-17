//! Plain file operations by absolute path.
//!
//! The UI uses these for the app's own store and for sync folders. The
//! assistant's file tools go through them too, but only after the user has
//! approved that specific call in the app.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_READ: u64 = 512 * 1024 * 1024;

fn err(path: &str, e: std::io::Error) -> String {
    format!("{path}: {e}")
}

/// Write to a temporary sibling and rename, so a crash or a sync client
/// never sees a half-written file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp: PathBuf = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn check_size(path: &str) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|e| err(path, e))?;
    if meta.is_dir() {
        return Err(format!("{path}: is a folder, not a file"));
    }
    if meta.len() > MAX_READ {
        return Err(format!("{path}: file is larger than 512 MB"));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn fs_read_text(path: String) -> Result<String, String> {
    check_size(&path)?;
    let bytes = fs::read(&path).map_err(|e| err(&path, e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command(async)]
pub fn fs_write_text(path: String, content: String) -> Result<(), String> {
    write_atomic(Path::new(&path), content.as_bytes()).map_err(|e| err(&path, e))
}

#[tauri::command(async)]
pub fn fs_read_b64(path: String) -> Result<String, String> {
    check_size(&path)?;
    let bytes = fs::read(&path).map_err(|e| err(&path, e))?;
    Ok(B64.encode(bytes))
}

#[tauri::command(async)]
pub fn fs_write_b64(path: String, data: String) -> Result<(), String> {
    let bytes = B64.decode(data.as_bytes()).map_err(|e| format!("invalid base64: {e}"))?;
    write_atomic(Path::new(&path), &bytes).map_err(|e| err(&path, e))
}

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    is_dir: bool,
    size: u64,
    modified_ms: u64,
}

#[tauri::command(async)]
pub fn fs_list(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| err(&path, e))? {
        let Ok(entry) = entry else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified_ms,
        });
    }
    Ok(out)
}

/// Removes a single file. Folders are deliberately not removed here.
#[tauri::command(async)]
pub fn fs_remove(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| err(&path, e))
}

#[tauri::command(async)]
pub fn fs_exists(path: String) -> bool {
    Path::new(&path).exists()
}
