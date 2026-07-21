use serde::Serialize;
use std::error::Error;
use std::io;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, State};

const TRAY_ID: &str = "amo-tray";
const SHOW_MENU_ID: &str = "amo-tray-show";
const HIDE_MENU_ID: &str = "amo-tray-hide";
const QUIT_MENU_ID: &str = "amo-tray-quit";
const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_OPEN_REQUESTED_EVENT: &str = "tray-open-requested";
const FLASH_INTERVAL: Duration = Duration::from_millis(650);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayOpenRequest {
    expand: bool,
    select_attention_filter: bool,
}

#[derive(Default)]
struct TrayRuntime {
    attention: bool,
    attention_icon_visible: bool,
    icon_revision: u64,
    next_flash_at: Option<Instant>,
    menu_deadline: Option<Instant>,
    suppress_next_left_release: bool,
    shutdown: bool,
    worker_started: bool,
}

struct TrayShared {
    runtime: Mutex<TrayRuntime>,
    native_operation: Mutex<()>,
    wake: Condvar,
    tray: TrayIcon,
    normal_icon: Image<'static>,
    attention_icon: Image<'static>,
}

#[derive(Clone)]
pub(crate) struct TrayState {
    shared: Arc<TrayShared>,
}

impl TrayState {
    fn new(tray: TrayIcon, normal_icon: Image<'static>, attention_icon: Image<'static>) -> Self {
        Self {
            shared: Arc::new(TrayShared {
                runtime: Mutex::new(TrayRuntime::default()),
                native_operation: Mutex::new(()),
                wake: Condvar::new(),
                tray,
                normal_icon,
                attention_icon,
            }),
        }
    }

    fn start_worker(&self) -> io::Result<()> {
        {
            let mut runtime = lock_runtime(&self.shared);
            if runtime.worker_started {
                return Ok(());
            }
            runtime.worker_started = true;
        }

        let shared = Arc::clone(&self.shared);
        if let Err(error) = thread::Builder::new()
            .name("amo-tray-runtime".to_string())
            .spawn(move || tray_worker(shared))
        {
            lock_runtime(&self.shared).worker_started = false;
            return Err(error);
        }

        Ok(())
    }

    fn set_attention(&self, attention: bool) -> Result<(), String> {
        {
            let mut runtime = lock_runtime(&self.shared);
            if runtime.shutdown {
                return Err("Tray runtime is shutting down.".to_string());
            }
            if runtime.attention == attention {
                return Ok(());
            }

            runtime.attention = attention;
            runtime.attention_icon_visible = attention;
            runtime.next_flash_at = attention.then(|| Instant::now() + FLASH_INTERVAL);
            runtime.icon_revision = runtime.icon_revision.wrapping_add(1);
        }

        self.shared.wake.notify_all();
        apply_current_icon(&self.shared).map_err(|error| error.to_string())
    }

    fn has_attention(&self) -> bool {
        lock_runtime(&self.shared).attention
    }

    fn schedule_left_click_menu(&self) {
        let mut runtime = lock_runtime(&self.shared);
        if runtime.shutdown {
            return;
        }
        if runtime.suppress_next_left_release {
            runtime.suppress_next_left_release = false;
            return;
        }

        runtime.menu_deadline = Some(Instant::now() + single_click_delay());
        drop(runtime);
        self.shared.wake.notify_all();
    }

    fn handle_double_click(&self) {
        let mut runtime = lock_runtime(&self.shared);
        runtime.menu_deadline = None;
        runtime.suppress_next_left_release = true;
        drop(runtime);
        self.shared.wake.notify_all();
    }

    fn shutdown_and_restore(&self) {
        {
            let mut runtime = lock_runtime(&self.shared);
            runtime.attention = false;
            runtime.attention_icon_visible = false;
            runtime.next_flash_at = None;
            runtime.menu_deadline = None;
            runtime.shutdown = true;
            runtime.icon_revision = runtime.icon_revision.wrapping_add(1);
        }

        self.shared.wake.notify_all();
        if let Err(error) = apply_current_icon(&self.shared) {
            eprintln!("failed to restore tray icon before exit: {error}");
        }
    }

    fn stop_worker(&self) {
        let mut runtime = lock_runtime(&self.shared);
        runtime.next_flash_at = None;
        runtime.menu_deadline = None;
        runtime.shutdown = true;
        drop(runtime);
        self.shared.wake.notify_all();
    }
}

pub(crate) fn install(app: &mut App) -> Result<(), Box<dyn Error>> {
    let app_icon = app.default_window_icon().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "icons/icon.ico was not available as the default app icon",
        )
    })?;
    let normal_icon = Image::new_owned(
        app_icon.rgba().to_vec(),
        app_icon.width(),
        app_icon.height(),
    );
    let attention_icon = make_attention_icon(&normal_icon);

    let show = MenuItemBuilder::with_id(SHOW_MENU_ID, "显示").build(app)?;
    let hide = MenuItemBuilder::with_id(HIDE_MENU_ID, "隐藏").build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, "退出").build(app)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(normal_icon.clone())
        .tooltip("Agent Monitor Overlay")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .build(app)?;

    let state = TrayState::new(tray.clone(), normal_icon, attention_icon);
    if !app.manage(state.clone()) {
        return Err(
            io::Error::new(io::ErrorKind::AlreadyExists, "tray state already installed").into(),
        );
    }
    state.start_worker()?;

    tray.on_menu_event(|app, event| {
        if event.id() == SHOW_MENU_ID {
            show_and_focus_main_window(app, None);
        } else if event.id() == HIDE_MENU_ID {
            hide_main_window(app);
        } else if event.id() == QUIT_MENU_ID {
            app.state::<TrayState>().shutdown_and_restore();
            crate::broker::stop_owned_broker();
            app.exit(0);
        }
    });

    tray.on_tray_icon_event(|tray, event| match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => tray
            .app_handle()
            .state::<TrayState>()
            .schedule_left_click_menu(),
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } => {
            let app = tray.app_handle();
            let state = app.state::<TrayState>();
            state.handle_double_click();
            show_and_focus_main_window(app, Some(state.has_attention()));
        }
        _ => {}
    });

    Ok(())
}

#[tauri::command]
pub(crate) fn set_tray_attention_state(
    attention: bool,
    state: State<'_, TrayState>,
) -> Result<(), String> {
    state.set_attention(attention)
}

pub(crate) fn stop_worker(app: &AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.stop_worker();
    }
}

fn tray_worker(shared: Arc<TrayShared>) {
    loop {
        let (show_menu, refresh_icon) = {
            let mut runtime = lock_runtime(&shared);
            loop {
                if runtime.shutdown {
                    return;
                }

                let now = Instant::now();
                let show_menu = runtime
                    .menu_deadline
                    .is_some_and(|deadline| deadline <= now);
                let refresh_icon = runtime
                    .next_flash_at
                    .is_some_and(|deadline| deadline <= now);

                if show_menu || refresh_icon {
                    if show_menu {
                        runtime.menu_deadline = None;
                    }
                    if refresh_icon {
                        runtime.attention_icon_visible = !runtime.attention_icon_visible;
                        runtime.next_flash_at = Some(now + FLASH_INTERVAL);
                        runtime.icon_revision = runtime.icon_revision.wrapping_add(1);
                    }
                    break (show_menu, refresh_icon);
                }

                let next_deadline = [runtime.menu_deadline, runtime.next_flash_at]
                    .into_iter()
                    .flatten()
                    .min();
                runtime = match next_deadline {
                    Some(deadline) => {
                        let timeout = deadline.saturating_duration_since(now);
                        let (next_runtime, _) = shared
                            .wake
                            .wait_timeout(runtime, timeout)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        next_runtime
                    }
                    None => shared
                        .wake
                        .wait(runtime)
                        .unwrap_or_else(|poisoned| poisoned.into_inner()),
                };
            }
        };

        if refresh_icon {
            if let Err(error) = apply_current_icon(&shared) {
                eprintln!("failed to update flashing tray icon: {error}");
            }
        }

        if show_menu {
            // Delay this ourselves so Windows still has a chance to report a double-click.
            let native_operation = shared
                .native_operation
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let result = shared
                .tray
                .with_inner_tray_icon(|tray_icon| tray_icon.show_menu());
            drop(native_operation);

            if let Err(error) = result {
                eprintln!("failed to show tray menu: {error}");
            }

            // The menu owns tray-icon's internal RefCell until TrackPopupMenu returns.
            // Apply any attention change that arrived while the menu was open afterwards.
            if let Err(error) = apply_current_icon(&shared) {
                eprintln!("failed to refresh tray icon after closing menu: {error}");
            }
        }
    }
}

fn apply_current_icon(shared: &TrayShared) -> tauri::Result<()> {
    let Ok(_native_operation) = shared.native_operation.try_lock() else {
        return Ok(());
    };

    loop {
        let (revision, icon) = {
            let runtime = lock_runtime(shared);
            let icon = if runtime.attention && runtime.attention_icon_visible {
                shared.attention_icon.clone()
            } else {
                shared.normal_icon.clone()
            };
            (runtime.icon_revision, icon)
        };

        let result = shared.tray.set_icon(Some(icon));
        if lock_runtime(shared).icon_revision == revision {
            return result;
        }
    }
}

fn lock_runtime(shared: &TrayShared) -> MutexGuard<'_, TrayRuntime> {
    shared
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn show_and_focus_main_window(app: &AppHandle, attention: Option<bool>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        eprintln!("main window is unavailable");
        return;
    };

    if let Err(error) = window.unminimize() {
        eprintln!("failed to unminimize main window: {error}");
    }
    if let Err(error) = window.show() {
        eprintln!("failed to show main window: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("failed to focus main window: {error}");
    }

    if let Some(select_attention_filter) = attention {
        let request = TrayOpenRequest {
            expand: true,
            select_attention_filter,
        };
        if let Err(error) = window.emit(TRAY_OPEN_REQUESTED_EVENT, request) {
            eprintln!("failed to emit {TRAY_OPEN_REQUESTED_EVENT}: {error}");
        }
    }
}

fn hide_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        eprintln!("main window is unavailable");
        return;
    };

    if let Err(error) = window.hide() {
        eprintln!("failed to hide main window: {error}");
    }
}

fn make_attention_icon(base: &Image<'_>) -> Image<'static> {
    let width = base.width();
    let height = base.height();
    let mut rgba = base.rgba().to_vec();
    let shortest_side = width.min(height);
    if shortest_side == 0 {
        return Image::new_owned(rgba, width, height);
    }

    let outer_radius = (shortest_side / 5).max(2);
    let inner_radius = outer_radius.saturating_sub((outer_radius / 3).max(1));
    let margin = (shortest_side / 16).max(1);
    let center_x = width.saturating_sub(outer_radius + margin);
    let center_y = height.saturating_sub(outer_radius + margin);

    paint_circle(
        &mut rgba,
        width,
        height,
        center_x,
        center_y,
        outer_radius,
        [42, 37, 31, 255],
    );
    paint_circle(
        &mut rgba,
        width,
        height,
        center_x,
        center_y,
        inner_radius,
        [255, 181, 54, 255],
    );

    Image::new_owned(rgba, width, height)
}

#[allow(clippy::too_many_arguments)]
fn paint_circle(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    center_x: u32,
    center_y: u32,
    radius: u32,
    color: [u8; 4],
) {
    let radius_squared = i64::from(radius) * i64::from(radius);
    for y in 0..height {
        let dy = i64::from(y) - i64::from(center_y);
        for x in 0..width {
            let dx = i64::from(x) - i64::from(center_x);
            if dx * dx + dy * dy > radius_squared {
                continue;
            }

            let offset = ((y * width + x) * 4) as usize;
            rgba[offset..offset + 4].copy_from_slice(&color);
        }
    }
}

#[cfg(windows)]
fn single_click_delay() -> Duration {
    let double_click_millis =
        unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime() };
    Duration::from_millis(u64::from(double_click_millis) + 50)
}

#[cfg(not(windows))]
fn single_click_delay() -> Duration {
    Duration::from_millis(550)
}
