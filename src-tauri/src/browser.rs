//! The browser the assistant drives: Meridian's own Chromium (Chrome for
//! Testing, downloaded once into the app's data folder and pinned to one
//! version) or the Firefox installed on the computer. Either runs with its own
//! profile folder, so the user's browser, logins and history are never touched.
//!
//! The app talks to it over the browser's debugging socket: Chrome DevTools
//! Protocol for Chromium, WebDriver BiDi for Firefox (see src/browser/*.ts).

use serde::Serialize;
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct BrowserState(pub Mutex<HashMap<u32, tokio::process::Child>>);

#[derive(Serialize)]
pub struct BrowserStatus {
    /// Meridian's own Chromium, when downloaded
    chromium: Option<String>,
    chromium_version: Option<String>,
    /// Firefox installed on this computer
    firefox: Option<String>,
    /// where the download comes from (shown to the user)
    platform: &'static str,
}

#[derive(Serialize)]
pub struct Launched {
    id: u32,
    ws_url: String,
}

#[cfg(desktop)]
mod imp {
    use super::*;
    use futures_util::StreamExt;
    use std::path::{Path, PathBuf};
    use tauri::{Emitter, Manager};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    const CFT_INDEX: &str = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

    pub fn cft_platform() -> &'static str {
        if cfg!(target_os = "windows") {
            "win64"
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "mac-arm64"
        } else if cfg!(target_os = "macos") {
            "mac-x64"
        } else {
            "linux64"
        }
    }

    fn exe_in(dir: &Path) -> PathBuf {
        let p = cft_platform();
        match p {
            "win64" => dir.join("chrome-win64").join("chrome.exe"),
            "linux64" => dir.join("chrome-linux64").join("chrome"),
            mac => dir
                .join(format!("chrome-{mac}"))
                .join("Google Chrome for Testing.app")
                .join("Contents")
                .join("MacOS")
                .join("Google Chrome for Testing"),
        }
    }

    fn root(app: &AppHandle) -> Result<PathBuf, String> {
        Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("browsers"))
    }

    pub fn installed(app: &AppHandle) -> Option<(String, String)> {
        let marker = root(app).ok()?.join("chromium").join("installed.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(marker).ok()?).ok()?;
        let exe = v["exe"].as_str()?.to_string();
        Path::new(&exe).exists().then(|| (exe, v["version"].as_str().unwrap_or("").to_string()))
    }

    pub fn find_firefox() -> Option<String> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if cfg!(target_os = "windows") {
            for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
                if let Ok(base) = std::env::var(var) {
                    candidates.push(Path::new(&base).join("Mozilla Firefox").join("firefox.exe"));
                }
            }
        } else if cfg!(target_os = "macos") {
            candidates.push("/Applications/Firefox.app/Contents/MacOS/firefox".into());
            if let Ok(home) = std::env::var("HOME") {
                candidates.push(Path::new(&home).join("Applications/Firefox.app/Contents/MacOS/firefox"));
            }
        } else if let Ok(path) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path) {
                candidates.push(dir.join("firefox"));
            }
        }
        candidates.into_iter().find(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned())
    }

    fn extract(zip_path: &Path, dest: &Path) -> Result<(), String> {
        let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let Some(rel) = entry.enclosed_name() else { continue };
            let out = dest.join(rel);
            let mode = entry.unix_mode();
            if entry.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            // macOS app bundles contain symbolic links (framework versions)
            #[cfg(unix)]
            if mode.map(|m| m & 0o170000 == 0o120000).unwrap_or(false) {
                let mut target = String::new();
                std::io::Read::read_to_string(&mut entry, &mut target).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&out);
                std::os::unix::fs::symlink(target, &out).map_err(|e| e.to_string())?;
                continue;
            }
            let mut f = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            if let Some(m) = mode {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&out, std::fs::Permissions::from_mode(m & 0o777)).map_err(|e| e.to_string())?;
            }
            #[cfg(not(unix))]
            let _ = mode;
        }
        Ok(())
    }

    pub async fn install(app: AppHandle) -> Result<String, String> {
        let progress = |stage: &str, done: u64, total: u64| {
            let _ = app.emit("browser-install", serde_json::json!({ "stage": stage, "done": done, "total": total }));
        };
        progress("finding the current version", 0, 0);
        let client = reqwest::Client::builder().user_agent("Meridian").build().map_err(|e| e.to_string())?;
        let body = client.get(CFT_INDEX).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
        let index: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let stable = &index["channels"]["Stable"];
        let version = stable["version"].as_str().ok_or("the Chromium version list is unreadable")?.to_string();
        let url = stable["downloads"]["chrome"]
            .as_array()
            .and_then(|list| list.iter().find(|d| d["platform"] == cft_platform()))
            .and_then(|d| d["url"].as_str())
            .ok_or("no Chromium download for this platform")?
            .to_string();

        let base = root(&app)?.join("chromium");
        let dir = base.join(&version);
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let zip_path = base.join(format!("chromium-{version}.zip"));
        let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("download failed: {}", res.status()));
        }
        let total = res.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(&zip_path).await.map_err(|e| e.to_string())?;
        let mut done = 0u64;
        let mut last = 0u64;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            done += chunk.len() as u64;
            if done - last > 2_000_000 {
                last = done;
                progress("downloading", done, total);
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        progress("unpacking", done, total);
        let _ = std::fs::remove_dir_all(&dir);
        let (zp, dp) = (zip_path.clone(), dir.clone());
        tokio::task::spawn_blocking(move || extract(&zp, &dp)).await.map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&zip_path);
        let exe = exe_in(&dir);
        if !exe.exists() {
            return Err("the download did not contain the browser".into());
        }
        // keep one version only
        if let Ok(entries) = std::fs::read_dir(&base) {
            for e in entries.flatten() {
                if e.path().is_dir() && e.path() != dir {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
        let exe_s = exe.to_string_lossy().into_owned();
        std::fs::write(base.join("installed.json"), serde_json::json!({ "version": version, "exe": exe_s }).to_string()).map_err(|e| e.to_string())?;
        progress("done", done, total);
        Ok(exe_s)
    }

    pub fn remove(app: &AppHandle) -> Result<(), String> {
        let base = root(app)?.join("chromium");
        if base.exists() {
            std::fs::remove_dir_all(base).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn free_port() -> Result<u16, String> {
        let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        Ok(l.local_addr().map_err(|e| e.to_string())?.port())
    }

    pub async fn launch(app: &AppHandle, state: &BrowserState, kind: &str, exe: Option<String>, headless: bool) -> Result<Launched, String> {
        let profiles = root(app)?.join("profiles");
        let profile = profiles.join(if kind == "firefox" { "firefox" } else { "chromium" });
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        let exe = match exe {
            Some(e) => e,
            None if kind == "firefox" => find_firefox().ok_or("Firefox is not installed on this computer")?,
            None => installed(app).map(|(e, _)| e).ok_or("Meridian's Chromium is not downloaded yet (Settings → Tools & computer → Browser)")?,
        };
        let mut cmd = tokio::process::Command::new(&exe);
        let marker: &str;
        if kind == "firefox" {
            // a quiet, separate profile: no first-run pages, no default-browser prompt, no telemetry
            let prefs = [
                ("browser.shell.checkDefaultBrowser", "false"),
                ("browser.aboutwelcome.enabled", "false"),
                ("trailhead.firstrun.didSeeAboutWelcome", "true"),
                ("datareporting.policy.dataSubmissionEnabled", "false"),
                ("toolkit.telemetry.reportingpolicy.firstRun", "false"),
                ("browser.startup.homepage_override.mstone", "\"ignore\""),
                ("remote.active-protocols", "1"),
            ];
            let user_js: String = prefs.iter().map(|(k, v)| format!("user_pref(\"{k}\", {v});\n")).collect();
            std::fs::write(profile.join("user.js"), user_js).map_err(|e| e.to_string())?;
            let port = free_port()?;
            cmd.arg("-no-remote").arg("-profile").arg(&profile).arg("--remote-debugging-port").arg(port.to_string());
            if headless {
                cmd.arg("-headless");
            }
            cmd.arg("about:blank");
            marker = "WebDriver BiDi listening on ";
        } else {
            cmd.arg("--remote-debugging-port=0")
                .arg(format!("--user-data-dir={}", profile.to_string_lossy()))
                .arg("--no-first-run")
                .arg("--no-default-browser-check")
                .arg("--disable-features=Translate,MediaRouter")
                .arg("--window-size=1280,900");
            if headless {
                cmd.arg("--headless=new");
            }
            // Chromium will not start as root with its sandbox on (containers, some Linux setups)
            if cfg!(target_os = "linux") && std::env::var("HOME").map(|h| h == "/root").unwrap_or(false) {
                cmd.arg("--no-sandbox");
            }
            cmd.arg("about:blank");
            marker = "DevTools listening on ";
        }
        cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("could not start the browser: {e}"))?;
        let stderr = child.stderr.take().ok_or("no browser output")?;
        let mut lines = BufReader::new(stderr).lines();
        let ws = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(i) = line.find(marker) {
                    return Some(line[i + marker.len()..].trim().to_string());
                }
            }
            None
        })
        .await
        .map_err(|_| "the browser did not start within 30 seconds".to_string())?
        .ok_or("the browser exited before it was ready")?;
        // keep draining its output so it never blocks on a full pipe
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        let id = child.id().unwrap_or(0);
        state.0.lock().map_err(|e| e.to_string())?.insert(id, child);
        Ok(Launched { id, ws_url: if kind == "firefox" { format!("{ws}/session") } else { ws } })
    }
}

#[tauri::command]
pub async fn browser_status(app: AppHandle) -> BrowserStatus {
    #[cfg(desktop)]
    {
        let ch = imp::installed(&app);
        BrowserStatus { chromium_version: ch.as_ref().map(|c| c.1.clone()), chromium: ch.map(|c| c.0), firefox: imp::find_firefox(), platform: imp::cft_platform() }
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        BrowserStatus { chromium: None, chromium_version: None, firefox: None, platform: "mobile" }
    }
}

#[tauri::command]
pub async fn browser_install_chromium(app: AppHandle) -> Result<String, String> {
    #[cfg(desktop)]
    return imp::install(app).await;
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("The browser agent runs on Windows, macOS and Linux.".into())
    }
}

#[tauri::command]
pub async fn browser_remove_chromium(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    return imp::remove(&app);
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub async fn browser_launch(app: AppHandle, state: State<'_, BrowserState>, kind: String, exe: Option<String>, headless: bool) -> Result<Launched, String> {
    #[cfg(desktop)]
    return imp::launch(&app, &state, &kind, exe, headless).await;
    #[cfg(not(desktop))]
    {
        let _ = (app, state, kind, exe, headless);
        Err("The browser agent runs on Windows, macOS and Linux.".into())
    }
}

#[tauri::command]
pub fn browser_close(state: State<'_, BrowserState>, id: u32) -> Result<(), String> {
    if let Some(mut child) = state.0.lock().map_err(|e| e.to_string())?.remove(&id) {
        let _ = child.start_kill();
    }
    Ok(())
}
