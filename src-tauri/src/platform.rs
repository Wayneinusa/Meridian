use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    os: &'static str,
    desktop: bool,
    mobile: bool,
    hostname: String,
    data_dir: String,
    documents_dir: String,
    home_dir: String,
    desktop_dir: String,
    downloads_dir: String,
    icloud_drive: Option<String>,
    icloud_container: Option<String>,
    can_control_screen: bool,
    /// bundle identifier; the iCloud folder on other devices is named after it
    identifier: String,
}

fn s(p: tauri::Result<std::path::PathBuf>) -> String {
    p.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

fn hostname() -> String {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    if let Ok(v) = std::fs::read_to_string("/etc/hostname") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    std::env::consts::OS.to_string()
}

/// The iCloud Drive folder, where iCloud is set up on a desktop machine.
fn icloud_drive(home: &str) -> Option<String> {
    if home.is_empty() {
        return None;
    }
    let candidate = if cfg!(target_os = "windows") {
        std::path::Path::new(home).join("iCloudDrive")
    } else if cfg!(target_os = "macos") {
        std::path::Path::new(home).join("Library/Mobile Documents/com~apple~CloudDocs")
    } else {
        return None;
    };
    candidate.is_dir().then(|| candidate.to_string_lossy().into_owned())
}

// async: the iCloud lookup may block and must not run on the main thread
#[tauri::command(async)]
pub fn platform_info(app: AppHandle) -> PlatformInfo {
    let path = app.path();
    let home = s(path.home_dir());
    let data_dir = s(path.app_data_dir());
    if !data_dir.is_empty() {
        let _ = std::fs::create_dir_all(&data_dir);
    }
    PlatformInfo {
        os: std::env::consts::OS,
        desktop: cfg!(desktop),
        mobile: cfg!(mobile),
        hostname: hostname(),
        documents_dir: s(path.document_dir()),
        desktop_dir: s(path.desktop_dir()),
        downloads_dir: s(path.download_dir()),
        icloud_drive: icloud_drive(&home),
        icloud_container: crate::icloud::container(),
        can_control_screen: cfg!(any(target_os = "windows", target_os = "macos")),
        identifier: app.config().identifier.clone(),
        home_dir: home,
        data_dir,
    }
}
