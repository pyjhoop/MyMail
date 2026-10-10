//! 시스템 트레이: 창을 닫아도 앱이 남아 새 메일을 받는다. 우클릭 메뉴로 열기·새 메일·지금 동기화·알림 일시 중지·종료,
//! 툴팁과 작업 표시줄 배지에 안 읽은 수를 보인다.

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::notify::{self, PauseSpan};
use crate::store::Store;
use crate::sync::manager::SyncManager;

const MAIN: &str = "main";
const TRAY_ID: &str = "main";

/// 마지막으로 동기화가 끝난 시각(유닉스 초), 0은 아직 없음
static LAST_SYNC: AtomicI64 = AtomicI64::new(0);

/// 동기화가 한 번 끝났음을 기록한다(트레이 상태 줄의 "n분 전 동기화").
pub fn mark_synced() {
    LAST_SYNC.store(notify::now_secs(), Ordering::Relaxed);
}

/// 메뉴 항목 핸들. `refresh`가 글자를 바꾼다.
struct TrayState {
    tray: TrayIcon,
    status: MenuItem<tauri::Wry>,
    pause: Submenu<tauri::Wry>,
    resume: MenuItem<tauri::Wry>,
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn elapsed_text(last: i64, now: i64) -> String {
    let secs = (now - last).max(0);
    if secs < 60 {
        "방금".to_string()
    } else if secs < 3600 {
        format!("{}분 전", secs / 60)
    } else {
        format!("{}시간 전", secs / 3600)
    }
}

/// 트레이 메뉴의 상태 줄: "안 읽음 143 · 3분 전 동기화"
pub fn status_text(unread: u32, last_sync: i64, now: i64) -> String {
    if last_sync == 0 {
        format!("안 읽음 {unread} · 동기화 대기 중")
    } else {
        format!("안 읽음 {unread} · {} 동기화", elapsed_text(last_sync, now))
    }
}

/// 트레이 툴팁. `badge_unread`는 "안 읽은 수 표시"를 켠 계정의 안 읽은 수, `paused`는 알림 일시 중지 중인지.
pub fn tooltip_text(badge_unread: u32, paused: bool) -> String {
    let mut text = String::from("MyMail");
    if badge_unread > 0 {
        text.push_str(&format!(" · 안 읽음 {badge_unread}"));
    }
    if paused {
        text.push_str(" · 알림 일시 중지 중");
    }
    text
}

/// 작업 표시줄 아이콘 위에 얹는 안 읽은 수 배지(빨간 원 + 흰 숫자, 99 넘으면 "99+")
fn badge_icon(unread: u32) -> Option<Image<'static>> {
    let text = notify::badge_text(unread)?;
    Some(Image::new_owned(
        notify::badge_rgba(&text),
        notify::BADGE_SIZE,
        notify::BADGE_SIZE,
    ))
}

/// 안 읽은 수·동기화 시각·알림 일시 중지 상태를 트레이(툴팁·상태 줄·메뉴)와 작업 표시줄 배지에 반영한다.
pub fn refresh(app: &AppHandle) {
    let (Some(state), Some(store)) = (app.try_state::<TrayState>(), app.try_state::<Store>())
    else {
        return;
    };
    let now = notify::now_secs();
    let (unread, badge_unread) = store.unread_counts().unwrap_or((0, 0));
    let paused = notify::is_paused(store.notify_paused_until().ok().flatten(), now);
    let last = LAST_SYNC.load(Ordering::Relaxed);

    let _ = state.status.set_text(status_text(unread, last, now));
    let _ = state
        .tray
        .set_tooltip(Some(tooltip_text(badge_unread, paused)));
    let _ = state.pause.set_text(if paused {
        "알림 일시 중지 중"
    } else {
        "알림 일시 중지"
    });
    let _ = state.resume.set_enabled(paused);
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.set_overlay_icon(badge_icon(badge_unread));
    }
}

fn set_pause(app: &AppHandle, span: Option<PauseSpan>) {
    if let Some(store) = app.try_state::<Store>() {
        let until = span.map(|s| notify::pause_until(s, notify::now_secs()));
        let _ = store.set_notify_paused_until(until);
    }
    refresh(app);
}

/// 모든 계정을 지금 동기화한다.
fn sync_all(app: &AppHandle) {
    let ids: Vec<String> = app
        .try_state::<Store>()
        .and_then(|s| s.list_accounts().ok())
        .map(|a| a.into_iter().map(|a| a.id).collect())
        .unwrap_or_default();
    for id in ids {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app.state::<SyncManager>().sync_now(&app, &id, None).await;
        });
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "MyMail 열기", true, None::<&str>)?;
    let compose = MenuItem::with_id(app, "compose", "새 메일 쓰기", true, Some("Ctrl+N"))?;
    let sync = MenuItem::with_id(app, "sync", "지금 동기화", true, None::<&str>)?;
    let pause_1h = MenuItem::with_id(app, "pause-1h", "1시간", true, None::<&str>)?;
    let pause_8am = MenuItem::with_id(app, "pause-8am", "내일 오전 8시까지", true, None::<&str>)?;
    let pause_forever =
        MenuItem::with_id(app, "pause-forever", "다시 켤 때까지", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "pause-resume", "알림 다시 켜기", false, None::<&str>)?;
    let pause = Submenu::with_items(
        app,
        "알림 일시 중지",
        true,
        &[
            &pause_1h,
            &pause_8am,
            &pause_forever,
            &PredefinedMenuItem::separator(app)?,
            &resume,
        ],
    )?;
    let status = MenuItem::with_id(
        app,
        "status",
        "안 읽음 0 · 동기화 대기 중",
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &compose,
            &PredefinedMenuItem::separator(app)?,
            &sync,
            &pause,
            &PredefinedMenuItem::separator(app)?,
            &status,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("MyMail")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "compose" => {
                show_main(app);
                let _ = app.emit("tray-compose", ());
            }
            "sync" => sync_all(app),
            "pause-1h" => set_pause(app, Some(PauseSpan::OneHour)),
            "pause-8am" => set_pause(app, Some(PauseSpan::UntilTomorrow8am)),
            "pause-forever" => set_pause(app, Some(PauseSpan::UntilResumed)),
            "pause-resume" => set_pause(app, None),
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
    // 창·트레이가 같은 앱 아이콘(tauri.conf.json bundle.icon에서 만든 기본 창 아이콘)을 쓴다.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    app.manage(TrayState {
        tray,
        status,
        pause,
        resume,
    });
    refresh(app);

    // "n분 전 동기화" 글자와 일시 중지 만료를 주기적으로 맞춘다.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            refresh(&app);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn 상태_줄은_안_읽은_수와_동기화_시각을_보인다() {
        assert_eq!(
            status_text(143, 1000, 1000 + 180),
            "안 읽음 143 · 3분 전 동기화"
        );
        assert_eq!(status_text(0, 1000, 1010), "안 읽음 0 · 방금 동기화");
        assert_eq!(
            status_text(5, 1000, 1000 + 7300),
            "안 읽음 5 · 2시간 전 동기화"
        );
        assert_eq!(status_text(5, 0, 10), "안 읽음 5 · 동기화 대기 중");
    }

    #[test]
    fn 툴팁은_안_읽은_수와_일시_중지를_보인다() {
        assert_eq!(tooltip_text(0, false), "MyMail");
        assert_eq!(tooltip_text(143, false), "MyMail · 안 읽음 143");
        assert_eq!(
            tooltip_text(2, true),
            "MyMail · 안 읽음 2 · 알림 일시 중지 중"
        );
    }

    /// 트레이·창 아이콘의 원본인 icon.ico에 작은 크기(16·32px)가 들어 있어야 또렷하게 보인다.
    #[test]
    fn app_icon_has_small_sizes() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let ico = std::fs::read(root.join("icons/icon.ico")).unwrap();
        let count = u16::from_le_bytes([ico[4], ico[5]]) as usize;
        let sizes: Vec<u8> = (0..count).map(|i| ico[6 + i * 16]).collect();
        assert!(sizes.contains(&16) && sizes.contains(&32), "{sizes:?}");

        let conf = std::fs::read_to_string(root.join("tauri.conf.json")).unwrap();
        assert!(conf.contains("icons/32x32.png") && conf.contains("icons/icon.ico"));
    }
}
