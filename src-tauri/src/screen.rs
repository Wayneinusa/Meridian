//! Screenshots and synthetic mouse/keyboard input (Windows and macOS).
//!
//! Screenshots are scaled down so the long edge is at most 1568 px, which is
//! what vision models read well. Input coordinates arrive in that scaled
//! space and are mapped back to real screen pixels here.

use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Clone, Copy)]
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub struct Mapping {
    /// real pixels per screenshot pixel
    scale: f64,
    origin_x: i32,
    origin_y: i32,
}

#[derive(Default)]
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub struct ScreenState(pub Mutex<Option<Mapping>>);

#[derive(Serialize)]
pub struct Shot {
    png_b64: String,
    width: u32,
    height: u32,
    screen_width: u32,
    screen_height: u32,
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod imp {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

    const MAX_EDGE: f64 = 1568.0;

    pub fn screenshot(state: &ScreenState) -> Result<Shot, String> {
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        let monitor = monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or_else(|| monitors.first())
            .ok_or("no display found")?;
        let img = monitor.capture_image().map_err(|e| format!("screen capture failed: {e}"))?;
        let (w, h) = (img.width(), img.height());
        let scale = (w.max(h) as f64 / MAX_EDGE).max(1.0);
        let (sw, sh) = ((w as f64 / scale).round() as u32, (h as f64 / scale).round() as u32);
        let small = if scale > 1.0 { image::imageops::resize(&img, sw, sh, image::imageops::FilterType::Triangle) } else { img };

        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(small)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;

        // On macOS the capture is in physical pixels while input uses points.
        let logical_w = monitor.width().unwrap_or(w) as f64;
        let input_scale = if cfg!(target_os = "macos") { logical_w / sw as f64 } else { w as f64 / sw as f64 };
        *state.0.lock().map_err(|e| e.to_string())? =
            Some(Mapping { scale: input_scale, origin_x: monitor.x().unwrap_or(0), origin_y: monitor.y().unwrap_or(0) });

        Ok(Shot { png_b64: B64.encode(png), width: sw, height: sh, screen_width: w, screen_height: h })
    }

    fn parse_key(name: &str) -> Result<Key, String> {
        let k = name.trim().to_lowercase();
        Ok(match k.as_str() {
            "ctrl" | "control" => Key::Control,
            "alt" | "option" => Key::Alt,
            "shift" => Key::Shift,
            "win" | "windows" | "cmd" | "command" | "meta" | "super" => Key::Meta,
            "enter" | "return" => Key::Return,
            "tab" => Key::Tab,
            "esc" | "escape" => Key::Escape,
            "space" => Key::Space,
            "backspace" => Key::Backspace,
            "delete" | "del" => Key::Delete,
            "up" => Key::UpArrow,
            "down" => Key::DownArrow,
            "left" => Key::LeftArrow,
            "right" => Key::RightArrow,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" | "pgup" => Key::PageUp,
            "pagedown" | "pgdn" => Key::PageDown,
            "f1" => Key::F1,
            "f2" => Key::F2,
            "f3" => Key::F3,
            "f4" => Key::F4,
            "f5" => Key::F5,
            "f6" => Key::F6,
            "f7" => Key::F7,
            "f8" => Key::F8,
            "f9" => Key::F9,
            "f10" => Key::F10,
            "f11" => Key::F11,
            "f12" => Key::F12,
            other => {
                let mut chars = other.chars();
                match (chars.next(), chars.next()) {
                    (Some(c), None) => Key::Unicode(c),
                    _ => return Err(format!("unknown key \"{name}\"")),
                }
            }
        })
    }

    pub fn input(
        state: &ScreenState,
        action: &str,
        x: Option<i32>,
        y: Option<i32>,
        dy: Option<i32>,
        text: Option<String>,
        keys: Option<String>,
    ) -> Result<(), String> {
        let e = |err: enigo::InputError| err.to_string();
        let mut enigo = Enigo::new(&Settings::default()).map_err(|err| format!("cannot control input: {err}"))?;
        let mapping = *state.0.lock().map_err(|e| e.to_string())?;

        let go_to = |enigo: &mut Enigo| -> Result<(), String> {
            let (Some(x), Some(y)) = (x, y) else { return Err("x and y are required for this action".into()) };
            let m = mapping.ok_or("take a screenshot first so coordinates can be mapped to the screen")?;
            let rx = m.origin_x + (x as f64 * m.scale).round() as i32;
            let ry = m.origin_y + (y as f64 * m.scale).round() as i32;
            enigo.move_mouse(rx, ry, Coordinate::Abs).map_err(e)
        };

        match action {
            "move" => go_to(&mut enigo),
            "click" => {
                go_to(&mut enigo)?;
                enigo.button(Button::Left, Direction::Click).map_err(e)
            }
            "double_click" => {
                go_to(&mut enigo)?;
                enigo.button(Button::Left, Direction::Click).map_err(e)?;
                std::thread::sleep(std::time::Duration::from_millis(60));
                enigo.button(Button::Left, Direction::Click).map_err(e)
            }
            "right_click" => {
                go_to(&mut enigo)?;
                enigo.button(Button::Right, Direction::Click).map_err(e)
            }
            "scroll" => {
                if x.is_some() && y.is_some() {
                    go_to(&mut enigo)?;
                }
                enigo.scroll(dy.unwrap_or(3), Axis::Vertical).map_err(e)
            }
            "type" => enigo.text(&text.ok_or("text is required")?).map_err(e),
            "key" => {
                let combo = keys.ok_or("keys is required")?;
                let parsed = combo.split('+').map(parse_key).collect::<Result<Vec<_>, _>>()?;
                let Some((last, modifiers)) = parsed.split_last() else { return Err("keys is empty".into()) };
                for m in modifiers {
                    enigo.key(*m, Direction::Press).map_err(e)?;
                }
                let result = enigo.key(*last, Direction::Click).map_err(e);
                // always release modifiers, even if the main key failed
                for m in modifiers.iter().rev() {
                    let _ = enigo.key(*m, Direction::Release);
                }
                result
            }
            other => Err(format!("unknown action \"{other}\"")),
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command(async)]
pub fn screenshot(state: State<'_, ScreenState>) -> Result<Shot, String> {
    imp::screenshot(&state)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[tauri::command(async)]
pub fn input_action(
    state: State<'_, ScreenState>,
    action: String,
    x: Option<i32>,
    y: Option<i32>,
    dy: Option<i32>,
    text: Option<String>,
    keys: Option<String>,
) -> Result<(), String> {
    imp::input(&state, &action, x, y, dy, text, keys)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[tauri::command(async)]
pub fn screenshot(_state: State<'_, ScreenState>) -> Result<Shot, String> {
    Err("Screen capture is not available on this platform.".into())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[tauri::command(async)]
pub fn input_action(
    _state: State<'_, ScreenState>,
    _action: String,
    _x: Option<i32>,
    _y: Option<i32>,
    _dy: Option<i32>,
    _text: Option<String>,
    _keys: Option<String>,
) -> Result<(), String> {
    Err("Mouse and keyboard control is not available on this platform.".into())
}
