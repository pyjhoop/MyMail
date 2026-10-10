mod attachments;
mod auth;
mod commands;
mod compose;
mod notify;
mod providers;
mod store;
mod sync;
mod tray;
mod updater;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

/// 시작 프로그램으로 실행될 때 붙는 인자
const STARTUP_FLAG: &str = "--minimized";

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![STARTUP_FLAG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = store::Store::open(&dir.join("mymail.db"))?;
            app.manage(store);
            app.manage(Arc::new(auth::KeyringStore) as Arc<dyn auth::CredentialStore>);
            app.manage(attachments::SavedFiles::default());
            app.manage(sync::manager::SyncManager::default());
            // 저장된 계정은 앱을 켜는 즉시 동기화를 이어간다.
            app.state::<sync::manager::SyncManager>()
                .start_all(app.handle());
            tray::setup(app.handle())?;
            updater::spawn_auto_update(app.handle());
            // 로그인할 때 자동으로 켜진 경우에는 창 없이 트레이에서 시작한다.
            if std::env::args().any(|a| a == STARTUP_FLAG) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        // 창을 닫아도 트레이에 남아 새 메일을 받는다. 종료는 트레이 메뉴에서 한다.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_accounts,
            commands::list_folders,
            commands::list_mails,
            commands::search_mails,
            commands::get_mail,
            commands::add_account,
            commands::set_read,
            commands::set_starred,
            commands::sync_now,
            commands::delete_mail,
            commands::move_mail,
            commands::archive_mail,
            commands::save_draft,
            commands::get_draft,
            commands::discard_draft,
            commands::add_draft_attachment,
            commands::remove_draft_attachment,
            commands::send_draft,
            commands::suggest_addresses,
            commands::set_signature,
            commands::set_sign_replies,
            commands::update_account,
            commands::reorder_accounts,
            commands::remove_account,
            commands::save_attachment,
            commands::save_all_attachments,
            commands::reveal_saved_attachment,
            commands::get_autostart,
            commands::set_autostart,
            commands::app_version,
            commands::check_update,
            commands::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
