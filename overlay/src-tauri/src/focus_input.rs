//! Native window shape for Focus's visible surfaces. CSS transparency alone does
//! not exclude a WebView2 window from Windows hit testing. A window region does;
//! it also clips painting, so the frontend includes each surface's shadow inset.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct InputRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InputMode {
    Regions,
    Full,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusInputRegions {
    mode: InputMode,
    viewport_width: f64,
    viewport_height: f64,
    rects: Vec<InputRect>,
}

impl FocusInputRegions {
    fn validate(&self) -> Result<(), String> {
        if ![self.viewport_width, self.viewport_height]
            .iter()
            .all(|value| value.is_finite() && (1.0..=32768.0).contains(value))
        {
            return Err("Focus viewport dimensions must be finite and between 1 and 32768.".into());
        }
        if self.rects.len() > 512 {
            return Err("Focus input regions cannot exceed 512 rectangles.".into());
        }
        if self.rects.iter().any(|rect| {
            ![rect.x, rect.y, rect.width, rect.height]
                .iter()
                .all(|value| value.is_finite() && value.abs() <= 65536.0)
                || rect.width < 0.0
                || rect.height < 0.0
        }) {
            return Err("Focus input rectangles must have finite bounded coordinates and nonnegative sizes.".into());
        }
        Ok(())
    }

    // Scale CSS pixels using the actual client extent rather than assuming a
    // devicePixelRatio. Client origin is relative to the complete HWND, as
    // required by SetWindowRgn (including any non-client border offset).
    fn physical_rects(&self, width: i32, height: i32, x: i32, y: i32) -> Vec<[i32; 4]> {
        self.rects
            .iter()
            .filter_map(|rect| {
                let left = rect.x.clamp(0.0, self.viewport_width);
                let top = rect.y.clamp(0.0, self.viewport_height);
                let right = (rect.x + rect.width).clamp(0.0, self.viewport_width);
                let bottom = (rect.y + rect.height).clamp(0.0, self.viewport_height);
                if right <= left || bottom <= top {
                    return None;
                }
                Some([
                    x + (left * width as f64 / self.viewport_width).floor() as i32,
                    y + (top * height as f64 / self.viewport_height).floor() as i32,
                    x + (right * width as f64 / self.viewport_width).ceil() as i32,
                    y + (bottom * height as f64 / self.viewport_height).ceil() as i32,
                ])
            })
            .collect()
    }
}

#[tauri::command]
pub async fn set_focus_input_regions(
    window: tauri::WebviewWindow,
    payload: FocusInputRegions,
) -> Result<(), String> {
    if window.label() != "focus" {
        return Err("Only the Focus window can change its input regions.".into());
    }
    payload.validate()?;

    #[cfg(windows)]
    {
        // Keep HWND mutation on the UI thread. Waiting runs on a blocking worker
        // so neither the UI thread nor the async runtime is blocked by it.
        tauri::async_runtime::spawn_blocking(move || {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let target = window.clone();
            window
                .run_on_main_thread(move || {
                    let _ = sender.send(native::apply(&target, &payload));
                })
                .map_err(|error| format!("Could not schedule Focus input regions: {error}"))?;
            receiver
                .recv()
                .map_err(|error| format!("Focus input region update was interrupted: {error}"))?
        })
        .await
        .map_err(|error| format!("Focus input region worker failed: {error}"))?
    }
    #[cfg(not(windows))]
    {
        Err("Focus input regions are supported only on Windows.".into())
    }
}

#[cfg(windows)]
mod native {
    use super::{FocusInputRegions, InputMode};
    use std::{ffi::c_void, ptr::null_mut};
    use windows_sys::Win32::Foundation::{BOOL, HWND, POINT, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetClientRect, GetWindowRect};

    // These small stable Win32 declarations avoid changing Cargo feature flags
    // owned by other work. Their ABI matches winuser.h / wingdi.h.
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowRgn(window: HWND, region: *mut c_void, redraw: BOOL) -> i32;
        fn ClientToScreen(window: HWND, point: *mut POINT) -> BOOL;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRectRgn(left: i32, top: i32, right: i32, bottom: i32) -> *mut c_void;
        fn CombineRgn(
            destination: *mut c_void,
            first: *mut c_void,
            second: *mut c_void,
            mode: i32,
        ) -> i32;
        fn DeleteObject(object: *mut c_void) -> BOOL;
    }

    struct OwnedRegion(*mut c_void);

    impl Drop for OwnedRegion {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    DeleteObject(self.0);
                }
            }
        }
    }

    pub fn apply(window: &tauri::WebviewWindow, payload: &FocusInputRegions) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
        unsafe {
            if payload.mode == InputMode::Full {
                return if SetWindowRgn(hwnd, null_mut(), 1) != 0 {
                    Ok(())
                } else {
                    Err("Could not restore the full Focus window region.".into())
                };
            }
            let mut client = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let mut outer = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let mut origin = POINT { x: 0, y: 0 };
            if GetClientRect(hwnd, &mut client) == 0
                || GetWindowRect(hwnd, &mut outer) == 0
                || ClientToScreen(hwnd, &mut origin) == 0
            {
                return Err("Could not read Focus window coordinates.".into());
            }
            let width = client.right - client.left;
            let height = client.bottom - client.top;
            // Minimized windows may temporarily have no drawable client area.
            // Retain the previous region until the frontend sends its resize.
            if width <= 0 || height <= 0 {
                return Ok(());
            }
            let mut union = OwnedRegion(CreateRectRgn(0, 0, 0, 0));
            if union.0.is_null() {
                return Err("Could not allocate the Focus window region.".into());
            }
            for [left, top, right, bottom] in
                payload.physical_rects(width, height, origin.x - outer.left, origin.y - outer.top)
            {
                let part = OwnedRegion(CreateRectRgn(left, top, right, bottom));
                if part.0.is_null() || CombineRgn(union.0, union.0, part.0, 2 /* RGN_OR */) == 0 {
                    return Err("Could not combine Focus input regions.".into());
                }
            }
            if SetWindowRgn(hwnd, union.0, 1) == 0 {
                return Err("Could not apply Focus input regions.".into());
            }
            // On success Windows owns this HRGN and releases it when replaced
            // or when the window is destroyed. Never delete it ourselves.
            union.0 = null_mut();
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(rects: Vec<InputRect>) -> FocusInputRegions {
        FocusInputRegions {
            mode: InputMode::Regions,
            viewport_width: 100.0,
            viewport_height: 80.0,
            rects,
        }
    }

    #[test]
    fn scales_clamps_and_offsets_without_shrinking_hit_area() {
        let input = payload(vec![InputRect {
            x: -5.0,
            y: 2.5,
            width: 15.5,
            height: 100.0,
        }]);
        assert_eq!(input.physical_rects(150, 120, 8, 6), vec![[8, 9, 24, 126]]);
    }

    #[test]
    fn discards_empty_and_offscreen_rectangles() {
        let input = payload(vec![
            InputRect {
                x: 101.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            InputRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 10.0,
            },
        ]);
        assert!(input.physical_rects(100, 80, 0, 0).is_empty());
    }

    #[test]
    fn rejects_invalid_and_unbounded_geometry() {
        let mut input = payload(vec![InputRect {
            x: f64::NAN,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        }]);
        assert!(input.validate().is_err());
        input.rects[0].x = 0.0;
        input.rects[0].width = -1.0;
        assert!(input.validate().is_err());
        input.rects.clear();
        input.viewport_width = 0.0;
        assert!(input.validate().is_err());
        input.viewport_width = 100.0;
        input.rects = vec![
            InputRect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0
            };
            513
        ];
        assert!(input.validate().is_err());
    }
}
