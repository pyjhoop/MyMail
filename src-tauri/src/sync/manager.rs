//! 계정마다 백그라운드 동기화를 돌린다: 시작할 때 전체 동기화, 이후 받은편지함 변화를 기다렸다가(IMAP IDLE)
//! 맞추고, 푸시를 못 쓰면 주기적으로 조회한다. 사용자 조작을 서버에 보내는 일도 여기서 깨운다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

use super::outbox::{Outbox, KICK_DELAY, MAX_TRIES, RETRY_DELAY};
use super::scheduler::{open_folder_key, AccountSync};
use super::{sync_account, Progress, Scope, SyncError};
use crate::auth::CredentialStore;
use crate::providers::{self, MailProvider, ProviderError, WakeReason};
use crate::store::{NewMail, NotifySettings, Store};

/// 받은편지함 변화를 기다리는 최대 시간. IDLE이 조용히 끊겨도 이 시간 안에 한 번 다시 확인하는 안전망이기도 하다.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// 받은편지함 밖의 폴더를 보고 있을 때 그 폴더를 다시 맞추는 간격
const OPEN_FOLDER_INTERVAL: Duration = Duration::from_secs(45);
/// 푸시(IDLE)를 못 쓰는 서버(네이버)를 조회하는 간격. 조회는 STATUS 비교로 가볍게 하므로 짧게 둔다.
const POLL_INTERVAL: Duration = Duration::from_secs(20);
/// 한 바퀴의 최소 길이. 서버가 계속 변화를 알려도 쉬지 않고 도는 일을 막는다.
const MIN_ROUND: Duration = Duration::from_secs(2);
/// 첫 재시도 대기. 잠깐 끊겼다 돌아온 네트워크는 금방 이어지므로 짧게 둔다.
const RETRY_BASE: Duration = Duration::from_secs(10);
const RETRY_MAX: Duration = Duration::from_secs(15 * 60);

struct Entry {
    provider: Arc<dyn MailProvider>,
    sync: Arc<AccountSync>,
    outbox: Arc<Outbox>,
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
        let sync = Arc::new(AccountSync::default());
        let task = {
            let (app, provider, id) = (app.clone(), provider.clone(), account_id.to_string());
            let sync = sync.clone();
            tauri::async_runtime::spawn(async move {
                let store = app.state::<Store>();
                watch(
                    &store,
                    &*provider,
                    &sync,
                    &id,
                    |p| {
                        let _ = app.emit("sync-progress", p);
                    },
                    |mails, settings| notify_new(&app, &id, &settings, &mails),
                    || {
                        crate::tray::mark_synced();
                        crate::tray::refresh(&app);
                    },
                )
                .await;
            })
        };
        let previous = self.entries.lock().ok().and_then(|mut e| {
            e.insert(
                account_id.to_string(),
                Entry {
                    provider,
                    sync,
                    outbox: Arc::new(Outbox::default()),
                    task,
                },
            )
        });
        if let Some(previous) = previous {
            previous.task.abort();
        }
    }

    /// 계정을 지울 때 동기화를 멈춘다.
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

    /// 지금 서버와 맞춘다(창이 다시 보일 때, 새로고침 버튼). 끝나면 돌아온다.
    /// `open_folder_id`는 사용자가 보는 폴더의 id로, 가장 먼저 맞추고 이후 짧은 주기로 맞춘다.
    /// 이미 동기화 중이면 새로 시작하지 않고 그것이 끝나길 기다리며, 방금 끝났다면 다시 돌지 않는다.
    pub async fn sync_now(
        &self,
        app: &AppHandle,
        account_id: &str,
        open_folder_id: Option<&str>,
    ) -> Result<(), SyncError> {
        let (provider, sync) = self
            .entries
            .lock()
            .ok()
            .and_then(|e| {
                e.get(account_id)
                    .map(|entry| (entry.provider.clone(), entry.sync.clone()))
            })
            .ok_or(SyncError::NotConnected)?;
        let store = app.state::<Store>();
        let open = open_folder_id.and_then(|id| open_folder_key(account_id, id));
        sync.sync_now(&store, &*provider, account_id, open, |p| {
            let _ = app.emit("sync-progress", p);
        })
        .await
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

    /// 로컬에 반영한 사용자 조작을 서버에 보낸다. 연달아 부르면 0.3초 모아 계정마다 한 번에 하나씩 보내고,
    /// 이동한 메일은 대상 폴더를 바로 맞춘다. 연결이 없어 실패하면 큐에 남고, 짧게 다시 시도한 뒤 다음 동기화 때 보낸다.
    pub fn kick(&self, app: &AppHandle, account_id: &str) {
        // 읽음·삭제 같은 조작이 로컬에 반영됐으니 트레이의 안 읽은 수도 바로 맞춘다.
        crate::tray::refresh(app);
        let Some((provider, outbox)) = self.entries.lock().ok().and_then(|e| {
            e.get(account_id)
                .map(|entry| (entry.provider.clone(), entry.outbox.clone()))
        }) else {
            return;
        };
        if !outbox.claim() {
            return;
        }
        let (app, id) = (app.clone(), account_id.to_string());
        tauri::async_runtime::spawn(async move {
            let store = app.state::<Store>();
            let Ok(moved) = outbox
                .run(&store, &*provider, &id, KICK_DELAY, RETRY_DELAY, MAX_TRIES)
                .await
            else {
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

/// 새 메일을 Windows 알림으로 알린다. 사용자가 앱을 보고 있거나 알림이 일시 중지 중이면 알리지 않는다.
fn notify_new(app: &AppHandle, account_id: &str, settings: &NotifySettings, mails: &[NewMail]) {
    let focused = app
        .get_webview_window("main")
        .is_some_and(|w| w.is_focused().unwrap_or(false));
    if focused {
        return;
    }
    let paused = app.state::<Store>().notify_paused_until().ok().flatten();
    if !crate::notify::should_notify(settings, paused, crate::notify::now_secs()) {
        return;
    }
    let name = app
        .state::<Store>()
        .list_accounts()
        .ok()
        .and_then(|accounts| accounts.into_iter().find(|a| a.id == account_id))
        .map_or_else(String::new, |a| a.name);
    crate::notify::show(app, &name, settings, mails);
}

/// 대기를 마치거나, `sync_now`가 깨우면 곧바로 돌아온다.
async fn sleep_or_wake(sync: &AccountSync, delay: Duration) {
    tokio::select! {
        () = tokio::time::sleep(delay) => {}
        () = sync.wake.notified() => {}
    }
}

/// 동기화를 되풀이한다. 끝나지 않는 작업이라 `abort`로 멈춘다.
/// 앱을 켠 뒤 첫 동기화는 쌓여 있던 메일을 받는 것이라 알리지 않고, 이후 새로 받은 안 읽은 메일만 `on_new`로 알린다.
/// 어떤 폴더를 언제 맞출지는 `AccountSync::round`가 정하고, 여기서는 받은편지함 변화를 기다리는 일을 맡는다.
async fn watch(
    store: &Store,
    provider: &dyn MailProvider,
    sync: &AccountSync,
    account_id: &str,
    report: impl Fn(Progress),
    on_new: impl Fn(Vec<NewMail>, NotifySettings),
    on_synced: impl Fn(),
) {
    let mut first = true;
    let mut failures = 0u32;
    let mut woke: Option<WakeReason> = None;
    loop {
        let round = Instant::now();
        let watermark = if first {
            None
        } else {
            store.mail_watermark(account_id).ok()
        };
        match sync
            .round(store, provider, account_id, woke.take(), &report)
            .await
        {
            Ok(()) => {
                failures = 0;
                first = false;
                if let Some(mark) = watermark {
                    // 알림 대상은 계정 설정을 따른다(설정은 매번 읽어 바꾸면 바로 반영된다).
                    let settings = store.notify_settings(account_id).unwrap_or_default();
                    if settings.enabled {
                        if let Ok(mails) = store.new_unread(account_id, mark, &settings.scope) {
                            if !mails.is_empty() {
                                on_new(mails, settings);
                            }
                        }
                    }
                }
                on_synced();
            }
            Err(_) => {
                failures += 1;
                // 인증이 막힌 계정도 같은 간격으로 다시 시도한다: 사용자가 앱 비밀번호를 고치면 풀린다.
                sleep_or_wake(sync, retry_delay(failures)).await;
                continue;
            }
        }

        let inbox = store
            .folder_of_kind(account_id, "inbox")
            .ok()
            .flatten()
            .map(|(_, key)| key);
        if let Some(key) = &inbox {
            // 받은편지함이 아닌 폴더를 보고 있으면 그 폴더도 짧은 주기로 맞추려고 자주 깬다.
            let watching_other = sync.open_folder().is_some_and(|open| open != *key);
            let timeout = if watching_other {
                OPEN_FOLDER_INTERVAL
            } else {
                IDLE_TIMEOUT
            };
            let since = sync.baseline(key).await;
            match provider
                .wait_for_changes(key, timeout, since.as_ref())
                .await
            {
                Ok(reason) => {
                    woke = Some(reason);
                }
                Err(ProviderError::Unsupported(_)) => {
                    sleep_or_wake(sync, POLL_INTERVAL).await;
                    // 시간이 차서 깬 것으로 다뤄, 요약 상태(STATUS)가 그대로면 목록을 통째로 받지 않고 건너뛰게 한다.
                    woke = Some(WakeReason::TimedOut);
                }
                Err(_) => {
                    failures += 1;
                    sleep_or_wake(sync, retry_delay(failures)).await;
                    continue;
                }
            }
        } else {
            sleep_or_wake(sync, POLL_INTERVAL).await;
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
    fn 재시도_대기는_짧게_시작해_두_배씩_늘어_상한에서_멈춘다() {
        assert_eq!(retry_delay(1), Duration::from_secs(10));
        assert_eq!(retry_delay(2), Duration::from_secs(20));
        assert_eq!(retry_delay(3), Duration::from_secs(40));
        assert_eq!(retry_delay(50), RETRY_MAX);
        assert_eq!(retry_delay(u32::MAX), RETRY_MAX);
    }
}
