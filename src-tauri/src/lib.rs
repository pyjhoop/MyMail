mod auth;
mod commands;
mod providers;
mod store;
mod sync;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = store::Store::open(&dir.join("mymail.db"))?;
            app.manage(store);
            app.manage(Arc::new(auth::KeyringStore) as Arc<dyn auth::CredentialStore>);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_accounts,
            commands::list_folders,
            commands::list_mails,
            commands::get_mail,
            commands::add_account,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
