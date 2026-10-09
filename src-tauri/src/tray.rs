//! 시스템 트레이: 창을 닫아도 앱이 남아 새 메일을 받는다. 우클릭 메뉴로 열기·새 메일·시작 시 실행·종료.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

const MAIN: &str = "main";

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "MyMail 열기", true, None::<&str>)?;
    let compose = MenuItem::with_id(app, "compose", "새 메일", true, None::<&str>)?;
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Windows 시작 시 실행",
        true,
        enabled,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &compose, &separator, &autostart, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("MyMail")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "compose" => {
                show_main(app);
                let _ = app.emit("tray-compose", ());
            }
            "autostart" => {
                let launch = app.autolaunch();
                let _ = if launch.is_enabled().unwrap_or(false) {
                    launch.disable()
                } else {
                    launch.enable()
                };
                let _ = autostart.set_checked(launch.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
