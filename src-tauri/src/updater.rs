//! 자동 업데이트: GitHub 릴리즈의 `latest.json`을 보고 새 버전이 있으면 받아서 설치한다.
//! 시작 직후와 이후 6시간마다 확인하고, 설정 화면에서는 수동으로 확인·설치한다.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// 새 버전이 있으면 돌려준다. 없으면 `None`.
pub async fn check(app: &AppHandle) -> Result<Option<Update>, tauri_plugin_updater::Error> {
    app.updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()?
        .check()
        .await
}

pub fn info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone().filter(|b| !b.trim().is_empty()),
    }
}

/// 받아서 설치한다. Windows에서는 설치 프로그램이 앱을 닫고 새 버전으로 다시 연다.
pub async fn install(app: &AppHandle, update: &Update) -> Result<(), tauri_plugin_updater::Error> {
    let mut downloaded = 0u64;
    let handle = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = handle.emit("update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
}

/// 개발 중(`tauri dev`)에는 돌리지 않는다.
pub fn spawn_auto_update(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            // 네트워크가 없거나 릴리즈가 아직 없으면 조용히 다음 기회에 다시 본다.
            if let Ok(Some(update)) = check(&app).await {
                let _ = install(&app, &update).await;
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}
