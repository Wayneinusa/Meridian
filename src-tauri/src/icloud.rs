//! iCloud: find the app's ubiquity container (iOS, iPadOS, macOS).
//!
//! The container is an ordinary folder that the system keeps in sync with
//! iCloud Drive. Meridian writes one JSON file per conversation into
//! `<container>/Documents/Meridian`, and the same folder shows up in iCloud
//! Drive on every device - including iCloud for Windows.

#[cfg(any(target_os = "ios", target_os = "macos"))]
mod imp {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    use std::path::Path;

    /// `None` when the user is not signed in to iCloud, iCloud Drive is off
    /// for the app, or the build lacks the iCloud entitlement.
    pub fn container() -> Option<String> {
        let manager = NSFileManager::defaultManager();
        // nil = the first container listed in the app's entitlements
        let url = manager.URLForUbiquityContainerIdentifier(None)?;
        let path = url.path()?.to_string();
        let _ = std::fs::create_dir_all(Path::new(&path).join("Documents"));
        Some(path)
    }

    /// Files that exist only in the cloud appear as `.name.icloud` stubs on
    /// older systems. Ask iCloud to download them so the next sync can read them.
    pub fn prepare(dir: &str) -> Result<u32, String> {
        let manager = NSFileManager::defaultManager();
        let mut requested = 0;
        for sub in ["conversations", "blobs"] {
            let folder = Path::new(dir).join(sub);
            let _ = std::fs::create_dir_all(&folder);
            let Ok(entries) = std::fs::read_dir(&folder) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(real) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".icloud")) else { continue };
                let target = folder.join(real);
                let url = NSURL::fileURLWithPath(&NSString::from_str(&target.to_string_lossy()));
                if manager.startDownloadingUbiquitousItemAtURL_error(&url).is_ok() {
                    requested += 1;
                }
            }
        }
        Ok(requested)
    }
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
mod imp {
    pub fn container() -> Option<String> {
        None
    }
    pub fn prepare(_dir: &str) -> Result<u32, String> {
        Ok(0)
    }
}

pub fn container() -> Option<String> {
    imp::container()
}

/// Returns how many not-yet-downloaded files were requested from iCloud.
#[tauri::command(async)]
pub fn icloud_prepare(dir: String) -> Result<u32, String> {
    imp::prepare(&dir)
}
