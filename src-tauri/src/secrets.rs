//! API keys and connector tokens live in the OS credential store:
//! Windows Credential Manager, or the Keychain on iOS / iPadOS / macOS.
//!
//! Windows limits one credential to 2560 bytes, which is 1280 characters
//! (it stores UTF-16). Sign-in tokens are often longer (xAI's are three JWTs),
//! so a long value is split: the entry itself holds `CHUNKS<n>` and the parts
//! go in `<name>#0` … `<name>#<n-1>`.

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

const MARK: &str = "\u{1}meridian-chunks:";
/// UTF-16 units per stored part: under Windows' 1280, with room to spare
const PART: usize = 1000;

fn part_name(name: &str, i: usize) -> String {
    format!("{name}#{i}")
}

/// Split into parts of at most `max` UTF-16 units, never inside a character.
fn split(value: &str, max: usize) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut units = 0;
    for c in value.chars() {
        if units + c.len_utf16() > max {
            parts.push(String::new());
            units = 0;
        }
        units += c.len_utf16();
        parts.last_mut().unwrap().push(c);
    }
    parts
}

fn chunk_count(stored: &str) -> Option<usize> {
    stored.strip_prefix(MARK).and_then(|n| n.parse().ok())
}

/// The credential store operations the chunking is written against (the OS
/// store in the app, a map in tests).
trait Store {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

fn read(store: &impl Store, name: &str) -> Result<Option<String>, String> {
    let Some(head) = store.get(name)? else { return Ok(None) };
    let Some(n) = chunk_count(&head) else { return Ok(Some(head)) };
    let mut out = String::new();
    for i in 0..n {
        match store.get(&part_name(name, i))? {
            Some(p) => out.push_str(&p),
            None => return Err(format!("the saved value of {name} is incomplete (part {i} is missing); sign in again")),
        }
    }
    Ok(Some(out))
}

fn remove_parts(store: &impl Store, name: &str, from: usize) -> Result<(), String> {
    if let Some(n) = store.get(name)?.as_deref().and_then(chunk_count) {
        for i in from..n {
            store.delete(&part_name(name, i))?;
        }
    }
    Ok(())
}

fn write(store: &impl Store, name: &str, value: &str) -> Result<(), String> {
    if value.encode_utf16().count() <= PART && !value.starts_with(MARK) {
        remove_parts(store, name, 0)?;
        return store.set(name, value);
    }
    let parts = split(value, PART);
    // parts first, then the head that points at them, then any leftovers
    for (i, p) in parts.iter().enumerate() {
        store.set(&part_name(name, i), p)?;
    }
    remove_parts(store, name, parts.len())?;
    store.set(name, &format!("{MARK}{}", parts.len()))
}

fn erase(store: &impl Store, name: &str) -> Result<(), String> {
    remove_parts(store, name, 0)?;
    store.delete(name)
}

struct Os<'a>(&'a tauri::AppHandle);
impl Store for Os<'_> {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        imp::get(self.0, name)
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        imp::set(self.0, name, value)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        imp::delete(self.0, name)
    }
}

#[tauri::command(async)]
pub fn secret_get(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    read(&Os(&app), &name)
}

#[tauri::command(async)]
pub fn secret_set(app: tauri::AppHandle, name: String, value: String) -> Result<(), String> {
    write(&Os(&app), &name, &value)
}

#[tauri::command(async)]
pub fn secret_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    erase(&Os(&app), &name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::BTreeMap};

    /// A store with Windows' limit: 1280 UTF-16 units per entry.
    #[derive(Default)]
    struct Limited(RefCell<BTreeMap<String, String>>);
    impl Store for Limited {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            if value.encode_utf16().count() * 2 > 2560 {
                return Err("Attribute 'password encoded as UTF-16' is longer than platform limit of 2560 chars".into());
            }
            self.0.borrow_mut().insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(name);
            Ok(())
        }
    }

    #[test]
    fn long_sign_in_tokens_fit_in_the_windows_store() {
        let s = Limited::default();
        // about the size of xAI's tokens: an access token, a refresh token and an ID token
        let tokens = format!("{{\"access_token\":\"{}\",\"refresh_token\":\"{}\",\"id_token\":\"{}é笑\"}}", "a".repeat(1400), "r".repeat(300), "i".repeat(1500));
        write(&s, "oauth.provider.xai", &tokens).unwrap();
        assert_eq!(read(&s, "oauth.provider.xai").unwrap().as_deref(), Some(tokens.as_str()));
        assert_eq!(s.0.borrow().len(), 1 + 4);
        // a shorter value replaces it and leaves no stray parts
        write(&s, "oauth.provider.xai", "short").unwrap();
        assert_eq!(read(&s, "oauth.provider.xai").unwrap().as_deref(), Some("short"));
        assert_eq!(s.0.borrow().len(), 1);
        write(&s, "oauth.provider.xai", &tokens).unwrap();
        erase(&s, "oauth.provider.xai").unwrap();
        assert!(s.0.borrow().is_empty());
        assert_eq!(read(&s, "missing").unwrap(), None);
    }

    #[test]
    fn splits_never_break_a_character() {
        let v = "😀".repeat(700);
        let parts = split(&v, PART);
        assert!(parts.iter().all(|p| p.encode_utf16().count() <= PART));
        assert_eq!(parts.concat(), v);
    }
}
