//! 계정마다 백그라운드 동기화를 돌린다: 시작할 때 전체 동기화, 이후 받은편지함 변화를 기다렸다가(IMAP IDLE)
//! 맞추고, 푸시를 못 쓰면 주기적으로 조회한다. 사용자 조작을 서버에 보내는 일도 여기서 깨운다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

use super::{flush_pending, sync_account, Progress, Scope};
use crate::auth::CredentialStore;
use crate::providers::{self, MailProvider, ProviderError};
use crate::store::Store;

/// 받은편지함 변화를 기다리는 최대 시간. 서버가 연결을 끊기 전에 다시 건다.
const IDLE_TIMEOUT: Duration = Duration::from_secs(9 * 60);
/// 푸시를 못 쓰는 서버를 조회하는 간격
const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// 받은편지함만이 아니라 모든 폴더를 다시 맞추는 간격
const FULL_SYNC_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// 한 바퀴의 최소 길이. 서버가 계속 변화를 알려도 쉬지 않고 도는 일을 막는다.
const MIN_ROUND: Duration = Duration::from_secs(5);
const RETRY_BASE: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(15 * 60);

struct Entry {
    provider: Arc<dyn MailProvider>,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct SyncManager {
    entries: Mutex<HashMap<String, Entry>>,
}

impl SyncManager {
    /// 저장된 모든 계정의 동기화를 시작한다. 앱을 켤 때 한 번 부른다.
    /// 비밀번호를 읽지 못한 계정은 건너뛴다(계정은 남아 있으니 화면에서 다시 연결할 수 있다).
    pub fn start_all(&self, app: &AppHandle) {
        let store = app.state::<Store>();
        let credentials = app.state::<Arc<dyn CredentialStore>>();
        let Ok(accounts) = store.list_accounts() else {
            return;
        };
        for account in accounts {
            let Ok(Some(password)) = credentials.load(&account.id) else {
                continue;
            };
            if let Ok(provider) = providers::create(&account.provider, &account.email, &password) {
                self.start(app, &account.id, provider.into());
            }
        }
    }

    /// 계정의 동기화를 시작한다. 이미 돌고 있으면 새 것으로 바꾼다.
    pub fn start(&self, app: &AppHandle, account_id: &str, provider: Arc<dyn MailProvider>) {
        let task = {
            let (app, provider, id) = (app.clone(), provider.clone(), account_id.to_string());
            tauri::async_runtime::spawn(async move {
                let store = app.state::<Store>();
                watch(&store, &*provider, &id, |p| {
                    let _ = app.emit("sync-progress", p);
                })
                .await;
            })
        };
        let previous = self
            .entries
            .lock()
            .ok()
            .and_then(|mut e| e.insert(account_id.to_string(), Entry { provider, task }));
        if let Some(previous) = previous {
            previous.task.abort();
        }
    }

    /// 계정을 지울 때 동기화를 멈춘다.
    #[allow(dead_code)] // 계정 삭제 기능이 생기면 연결
    pub fn stop(&self, account_id: &str) {
        if let Some(entry) = self
            .entries
            .lock()
            .ok()
            .and_then(|mut e| e.remove(account_id))
        {
            entry.task.abort();
        }
    }

    /// 계정에 연결된 제공자. 동기화가 돌고 있지 않은 계정(비밀번호를 읽지 못한 경우 등)은 `None`.
    pub fn provider(&self, account_id: &str) -> Option<Arc<dyn MailProvider>> {
        self.entries
            .lock()
            .ok()
            .and_then(|e| e.get(account_id).map(|entry| entry.provider.clone()))
    }

    /// 메일을 보낸 뒤 보낸편지함을 바로 맞춘다. 실패해도 다음 동기화 때 나타난다.
    pub fn refresh_sent(&self, app: &AppHandle, account_id: &str) {
        let Some(provider) = self.provider(account_id) else {
            return;
        };
        let (app, id) = (app.clone(), account_id.to_string());
        tauri::async_runtime::spawn(async move {
            let store = app.state::<Store>();
            let Ok(Some((_, key))) = store.folder_of_kind(&id, "sent") else {
                return;
            };
            let _ = sync_account(&store, &*provider, &id, Scope::Folders(&[key]), |p| {
                let _ = app.emit("sync-progress", p);
            })
            .await;
        });
    }

    /// 로컬에 반영한 사용자 조작을 서버에 보낸다. 이동한 메일은 대상 폴더를 바로 맞춘다.
    /// 연결이 없어 실패하면 큐에 남고, 다음 동기화 때 다시 보낸다.
    pub fn kick(&self, app: &AppHandle, account_id: &str) {
        let Some(provider) = self
            .entries
            .lock()
            .ok()
            .and_then(|e| e.get(account_id).map(|entry| entry.provider.clone()))
        else {
            return;
        };
        let (app, id) = (app.clone(), account_id.to_string());
        tauri::async_runtime::spawn(async move {
            let store = app.state::<Store>();
            let Ok(moved) = flush_pending(&store, &*provider, &id).await else {
                return;
            };
            if !moved.is_empty() {
                let _ = sync_account(&store, &*provider, &id, Scope::Folders(&moved), |p| {
                    let _ = app.emit("sync-progress", p);
                })
                .await;
            }
        });
    }
}

/// 실패 횟수에 따른 재시도 대기 시간: 30초에서 시작해 두 배씩 늘어 최대 15분.
fn retry_delay(failures: u32) -> Duration {
    RETRY_BASE
        .saturating_mul(2u32.saturating_pow(failures.saturating_sub(1)))
        .min(RETRY_MAX)
}

/// 동기화를 되풀이한다. 끝나지 않는 작업이라 `abort`로 멈춘다.
async fn watch(
    store: &Store,
    provider: &dyn MailProvider,
    account_id: &str,
    report: impl Fn(Progress),
) {
    let mut last_full: Option<Instant> = None;
    let mut failures = 0u32;
    loop {
        let round = Instant::now();
        let full = last_full.is_none_or(|t| t.elapsed() >= FULL_SYNC_INTERVAL);
        let inbox = store
            .folder_of_kind(account_id, "inbox")
            .ok()
            .flatten()
            .map(|(_, key)| key);
        let result = match (&inbox, full) {
            (Some(key), false) => {
                sync_account(
                    store,
                    provider,
                    account_id,
                    Scope::Folders(std::slice::from_ref(key)),
                    &report,
                )
                .await
            }
            _ => sync_account(store, provider, account_id, Scope::All, &report).await,
        };
        match result {
            Ok(()) => {
                failures = 0;
                if full || inbox.is_none() {
                    last_full = Some(Instant::now());
                }
            }
            Err(_) => {
                failures += 1;
                // 인증이 막힌 계정도 같은 간격으로 다시 시도한다: 사용자가 앱 비밀번호를 고치면 풀린다.
                tokio::time::sleep(retry_delay(failures)).await;
                continue;
            }
        }

        if let Some(key) = &inbox {
            match provider.wait_for_changes(key, IDLE_TIMEOUT).await {
                Ok(()) => {}
                Err(ProviderError::Unsupported(_)) => tokio::time::sleep(POLL_INTERVAL).await,
                Err(_) => {
                    failures += 1;
                    tokio::time::sleep(retry_delay(failures)).await;
                    continue;
                }
            }
        } else {
            tokio::time::sleep(POLL_INTERVAL).await;
        }
        if let Some(rest) = MIN_ROUND.checked_sub(round.elapsed()) {
            tokio::time::sleep(rest).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 재시도_대기는_두_배씩_늘어_상한에서_멈춘다() {
        assert_eq!(retry_delay(1), Duration::from_secs(30));
        assert_eq!(retry_delay(2), Duration::from_secs(60));
        assert_eq!(retry_delay(3), Duration::from_secs(120));
        assert_eq!(retry_delay(50), RETRY_MAX);
        assert_eq!(retry_delay(u32::MAX), RETRY_MAX);
    }
}
