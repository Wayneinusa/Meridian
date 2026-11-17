//! Native side of Meridian: the things a web view cannot do by itself.
//!
//! - files anywhere on disk (the app's own store, sync folders, and - on
//!   desktop, after the user approves each call in the UI - the user's files)
//! - shell commands, app launching and installs (desktop only)
//! - screenshots and mouse/keyboard (Windows and macOS)
//! - the OS credential store for API keys
//! - local MCP servers over stdio (desktop only)
//! - the iCloud container (iOS, iPadOS, macOS)

mod background;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .manage(oauth::OAuthState::default())
        .manage(mcp::McpState::default())
        .manage(screen::ScreenState::default())
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
            icloud::icloud_prepare,
            oauth::oauth_listen,
            oauth::oauth_wait,
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
