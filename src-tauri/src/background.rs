//! Desktop: when "keep running in the background" is on, closing the window
//! hides it and a tray icon stays, so automations keep running on schedule.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

pub static BACKGROUND: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
fn show_main(app: &AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(desktop)]
fn ensure_tray(app: &AppHandle, enabled: bool) -> Result<(), String> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    if !enabled {
        let _ = app.remove_tray_by_id("main");
        return Ok(());
    }
    if app.tray_by_id("main").is_some() {
        return Ok(());
    }
    let show = MenuItem::with_id(app, "show", "Open Meridian", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|e| e.to_string())?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Meridian")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => {
                BACKGROUND.store(false, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_background(app: AppHandle, enabled: bool) -> Result<(), String> {
    BACKGROUND.store(enabled, Ordering::SeqCst);
    #[cfg(desktop)]
    ensure_tray(&app, enabled)?;
    #[cfg(mobile)]
    let _ = app;
    Ok(())
}

pub fn keep_in_background() -> bool {
    BACKGROUND.load(Ordering::SeqCst)
}
