//! API keys and connector tokens live in the OS credential store:
//! Windows Credential Manager, or the Keychain on iOS / iPadOS / macOS.

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "ios"))]
mod imp {
    use keyring::{Entry, Error};
    const SERVICE: &str = "Meridian";

    pub fn get(_app: &tauri::AppHandle, name: &str) -> Result<Option<String>, String> {
        match Entry::new(SERVICE, name).and_then(|e| e.get_password()) {
            Ok(v) => Ok(Some(v)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn set(_app: &tauri::AppHandle, name: &str, value: &str) -> Result<(), String> {
        Entry::new(SERVICE, name).and_then(|e| e.set_password(value)).map_err(|e| e.to_string())
    }
    pub fn delete(_app: &tauri::AppHandle, name: &str) -> Result<(), String> {
        match Entry::new(SERVICE, name).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Linux / Android development fallback: a file only the user can read, in
/// the app's data folder. The shipping targets (Windows, iOS, iPadOS) never
/// use this.
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "ios")))]
mod imp {
    use std::{collections::BTreeMap, fs, path::PathBuf};
    use tauri::Manager;

    fn file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.join("secrets.json"))
    }
    fn load(app: &tauri::AppHandle) -> Result<BTreeMap<String, String>, String> {
        match fs::read_to_string(file(app)?) {
            Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(e.to_string()),
        }
    }
    fn store(app: &tauri::AppHandle, map: &BTreeMap<String, String>) -> Result<(), String> {
        let path = file(app)?;
        fs::write(&path, serde_json::to_string(map).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
    pub fn get(app: &tauri::AppHandle, name: &str) -> Result<Option<String>, String> {
        Ok(load(app)?.get(name).cloned())
    }
    pub fn set(app: &tauri::AppHandle, name: &str, value: &str) -> Result<(), String> {
        let mut map = load(app)?;
        map.insert(name.to_string(), value.to_string());
        store(app, &map)
    }
    pub fn delete(app: &tauri::AppHandle, name: &str) -> Result<(), String> {
        let mut map = load(app)?;
        map.remove(name);
        store(app, &map)
    }
}

#[tauri::command(async)]
pub fn secret_get(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    imp::get(&app, &name)
}

#[tauri::command(async)]
pub fn secret_set(app: tauri::AppHandle, name: String, value: String) -> Result<(), String> {
    imp::set(&app, &name, &value)
}

#[tauri::command(async)]
pub fn secret_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    imp::delete(&app, &name)
}
