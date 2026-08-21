use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

const MINIMUM_WIDTH: u32 = 900;
const MINIMUM_HEIGHT: u32 = 600;
const DEFAULT_WIDTH: u32 = 1100;
const DEFAULT_HEIGHT: u32 = 720;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct WindowBounds {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug)]
struct DisplayBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

pub fn restore(window: &WebviewWindow, path: &Path) {
    let displays = monitor_bounds(window);
    let persisted = fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<WindowBounds>(&content).ok());
    let bounds = sanitize(persisted, &displays);
    let _ = window.set_size(PhysicalSize::new(bounds.width, bounds.height));
    if let (Some(x), Some(y)) = (bounds.x, bounds.y) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    } else {
        let _ = window.center();
    }
}

pub fn save(window: &WebviewWindow, path: &Path) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let bounds = WindowBounds {
        x: Some(position.x),
        y: Some(position.y),
        width: size.width,
        height: size.height,
    };
    if let Ok(json) = serde_json::to_string(&bounds) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, format!("{json}\n"));
    }
}

fn sanitize(persisted: Option<WindowBounds>, displays: &[DisplayBounds]) -> WindowBounds {
    let default = WindowBounds {
        x: None,
        y: None,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
    };
    let Some(bounds) = persisted else {
        return default;
    };
    if bounds.width < MINIMUM_WIDTH
        || bounds.height < MINIMUM_HEIGHT
        || bounds.x.is_some() != bounds.y.is_some()
    {
        return default;
    }
    let (Some(x), Some(y)) = (bounds.x, bounds.y) else {
        return bounds;
    };
    displays
        .iter()
        .any(|display| rectangles_overlap(bounds, *display))
        .then_some(WindowBounds {
            x: Some(x),
            y: Some(y),
            ..bounds
        })
        .unwrap_or(default)
}

fn rectangles_overlap(window: WindowBounds, display: DisplayBounds) -> bool {
    let (Some(x), Some(y)) = (window.x, window.y) else {
        return true;
    };
    i64::from(x) < i64::from(display.x) + i64::from(display.width)
        && i64::from(x) + i64::from(window.width) > i64::from(display.x)
        && i64::from(y) < i64::from(display.y) + i64::from(display.height)
        && i64::from(y) + i64::from(window.height) > i64::from(display.y)
}

fn monitor_bounds(window: &WebviewWindow) -> Vec<DisplayBounds> {
    window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|monitor| DisplayBounds {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DISPLAYS: [DisplayBounds; 1] = [DisplayBounds {
        x: 0,
        y: 0,
        width: 1512,
        height: 982,
    }];

    #[test]
    fn rejects_small_partial_and_offscreen_bounds() {
        for bounds in [
            WindowBounds {
                x: Some(10),
                y: Some(10),
                width: 899,
                height: 720,
            },
            WindowBounds {
                x: Some(10),
                y: None,
                width: 1100,
                height: 720,
            },
            WindowBounds {
                x: Some(4000),
                y: Some(1200),
                width: 1100,
                height: 720,
            },
        ] {
            assert_eq!(
                sanitize(Some(bounds), &DISPLAYS),
                WindowBounds {
                    x: None,
                    y: None,
                    width: DEFAULT_WIDTH,
                    height: DEFAULT_HEIGHT
                },
            );
        }
    }

    #[test]
    fn retains_visible_legacy_electron_bounds() {
        let bounds = WindowBounds {
            x: Some(120),
            y: Some(80),
            width: 1200,
            height: 800,
        };
        assert_eq!(sanitize(Some(bounds), &DISPLAYS), bounds);
    }
}
