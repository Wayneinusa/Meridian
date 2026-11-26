//! Native side of Meridian: the things a web view cannot do by itself.
//!
//! - files anywhere on disk (the app's own store, sync folders, and - on
//!   desktop, after the user approves each call in the UI - the user's files)
//! - shell commands, app launching and installs (desktop only)
//! - screenshots and mouse/keyboard (Windows and macOS), with a kill switch
//! - the assistant's own browser (managed Chromium or Firefox, separate profile)
//! - the OS credential store for API keys
//! - local MCP servers over stdio (desktop only)
//! - the iCloud container (iOS, iPadOS, macOS)

mod background;
mod browser;
mod fs_cmds;
mod icloud;
mod mcp;
mod oauth;
mod platform;
mod screen;
mod secrets;
mod shell;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // the computer-use kill switch (a global shortcut) exists on desktop only
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .manage(oauth::OAuthState::default())
        .manage(mcp::McpState::default())
        .manage(screen::ScreenState::default())
        .manage(browser::BrowserState::default())
        .invoke_handler(tauri::generate_handler![
            platform::platform_info,
            fs_cmds::fs_read_text,
            fs_cmds::fs_write_text,
            fs_cmds::fs_read_b64,
            fs_cmds::fs_write_b64,
            fs_cmds::fs_list,
            fs_cmds::fs_remove,
            fs_cmds::fs_exists,
            shell::run_command,
            shell::open_target,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            mcp::mcp_stdio_start,
            mcp::mcp_stdio_send,
            mcp::mcp_stdio_stop,
            screen::screenshot,
            screen::input_action,
            screen::list_windows,
            screen::computer_kill,
            browser::browser_status,
            browser::browser_install_chromium,
            browser::browser_remove_chromium,
            browser::browser_launch,
            browser::browser_close,
            icloud::icloud_prepare,
            oauth::oauth_listen,
            oauth::oauth_wait,
            oauth::oauth_cancel,
            background::set_background,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if background::keep_in_background() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Meridian");
}
