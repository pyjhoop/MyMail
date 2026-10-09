//! 계정 하나의 동기화 순서와 주기를 정한다. Tauri에 기대지 않아 `FakeProvider`로 시험할 수 있다.
//!
//! - 받은편지함: 변화가 오거나 `manager`의 안전망 주기가 지날 때마다 맞춘다.
//! - 나머지 폴더: `OTHER_FOLDERS_INTERVAL`마다 맞추되 요약 상태(STATUS)가 그대로인 폴더는 건너뛴다.
//! - 별표처럼 요약 상태에 드러나지 않는 변화: `FULL_CHECK_INTERVAL`마다 건너뛰지 않고 전부 대조한다.
//! - 지금 보는 폴더: 매번 건너뛰지 않고, 가장 먼저 맞춘다.
//! - `sync_now`: 사용자가 바로 맞추라고 할 때. 동시에·잇따라 불러도 한 번만 돈다.

use std::time::{Duration, Instant};

use tokio::sync::{Mutex, Notify};

use super::{sync_account_with, Progress, Scope, StatusCache, SyncError, SyncOptions};
use crate::providers::{FolderStatus, MailProvider, WakeReason};
use crate::store::{folder_key, Store};

/// 받은편지함 밖의 폴더를 다시 확인하는 간격
const OTHER_FOLDERS_INTERVAL: Duration = Duration::from_secs(3 * 60);
/// 한 바퀴가 이만큼 일찍 와도 간격이 찬 것으로 본다(받은편지함 주기와 어긋나 한 바퀴 더 기다리는 일을 막는다).
const INTERVAL_SLACK: Duration = Duration::from_secs(15);
/// 요약 상태가 같아도 모든 폴더를 전부 대조하는 간격. 별표 같은 변화를 잡는다.
const FULL_CHECK_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// 이 시간 안에 끝난 동기화가 있으면 `sync_now`는 새로 돌지 않는다(창 포커스가 연달아 오는 경우 등).
const COALESCE_WINDOW: Duration = Duration::from_secs(2);

#[derive(Default)]
struct State {
    /// 마지막으로 맞춘 시점의 폴더 요약 상태
    statuses: StatusCache,
    last_others: Option<Instant>,
    last_full_check: Option<Instant>,
    last_done: Option<Instant>,
}

/// 계정마다 하나. 동기화는 `state` 잠금 안에서만 돌아 한 번에 하나다.
#[derive(Default)]
pub struct AccountSync {
    state: Mutex<State>,
    /// 사용자가 보고 있는 폴더의 서버 key
    open_folder: std::sync::Mutex<Option<String>>,
    /// 재시도·조회 대기를 깨우는 신호(`sync_now`가 보낸다)
    pub wake: Notify,
}

impl AccountSync {
    pub fn set_open_folder(&self, key: Option<String>) {
        if let Ok(mut open) = self.open_folder.lock() {
            *open = key;
        }
    }

    pub fn open_folder(&self) -> Option<String> {
        self.open_folder.lock().ok().and_then(|open| open.clone())
    }

    /// 폴더를 마지막으로 맞춘 시점의 요약 상태. IDLE을 걸 때 그 사이의 변화를 비교하는 기준이다.
    pub async fn baseline(&self, folder_key: &str) -> Option<FolderStatus> {
        self.state.lock().await.statuses.get(folder_key).cloned()
    }

    /// 백그라운드 한 바퀴. `woke`는 직전 대기가 끝난 이유다(`None`이면 첫 바퀴나 오류 뒤 재시도).
    pub async fn round(
        &self,
        store: &Store,
        provider: &dyn MailProvider,
        account_id: &str,
        woke: Option<WakeReason>,
        report: impl Fn(Progress),
    ) -> Result<(), SyncError> {
        let mut state = self.state.lock().await;
        let inbox = store
            .folder_of_kind(account_id, "inbox")
            .ok()
            .flatten()
            .map(|(_, key)| key);
        let open = self.open_folder();

        let full_check = state
            .last_full_check
            .is_none_or(|t| t.elapsed() >= FULL_CHECK_INTERVAL);
        let others_due = state
            .last_others
            .is_none_or(|t| t.elapsed() + INTERVAL_SLACK >= OTHER_FOLDERS_INTERVAL);
        let all = full_check || others_due || inbox.is_none();

        // 받은편지함만 맞출 때, 변화 알림이 와서 깬 것이 아니라 안전망 시간이 차서 깬 것이면 요약 상태로 건너뛴다.
        let (keys, skip_unchanged) = if all {
            (Vec::new(), !full_check)
        } else {
            let mut keys: Vec<String> = inbox.into_iter().collect();
            if let Some(open) = &open {
                if !keys.contains(open) {
                    keys.push(open.clone());
                }
            }
            (keys, woke == Some(WakeReason::TimedOut))
        };
        let scope = if all {
            Scope::All
        } else {
            Scope::Folders(&keys)
        };
        sync_account_with(
            store,
            provider,
            account_id,
            scope,
            SyncOptions {
                cache: Some(&mut state.statuses),
                skip_unchanged,
                first: open.as_deref(),
            },
            report,
        )
        .await?;

        let now = Instant::now();
        if full_check {
            state.last_full_check = Some(now);
        }
        if all {
            state.last_others = Some(now);
        }
        state.last_done = Some(now);
        Ok(())
    }

    /// 지금 서버와 맞춘다. 모든 폴더를 대상으로 하되 `open_folder`(서버 key)를 가장 먼저 맞춘다.
    /// 이미 동기화 중이면 새로 시작하지 않고 그것이 끝나길 기다린 뒤 돌아온다. 방금 끝난 동기화가 있어도 다시 돌지 않는다.
    pub async fn sync_now(
        &self,
        store: &Store,
        provider: &dyn MailProvider,
        account_id: &str,
        open_folder: Option<String>,
        report: impl Fn(Progress),
    ) -> Result<(), SyncError> {
        if open_folder.is_some() {
            self.set_open_folder(open_folder);
        }
        // 오류 뒤 재시도 대기 중이면 깨운다.
        self.wake.notify_waiters();

        let Ok(mut state) = self.state.try_lock() else {
            drop(self.state.lock().await);
            return Ok(());
        };
        if state
            .last_done
            .is_some_and(|t| t.elapsed() < COALESCE_WINDOW)
        {
            return Ok(());
        }
        let open = self.open_folder();
        sync_account_with(
            store,
            provider,
            account_id,
            Scope::All,
            SyncOptions {
                cache: Some(&mut state.statuses),
                skip_unchanged: true,
                first: open.as_deref(),
            },
            report,
        )
        .await?;
        let now = Instant::now();
        state.last_others = Some(now);
        state.last_done = Some(now);
        Ok(())
    }
}

/// 폴더 id(`계정id-폴더`)가 이 계정의 것이면 서버 key로 바꾼다.
pub fn open_folder_key(account_id: &str, folder_id: &str) -> Option<String> {
    folder_id
        .starts_with(&format!("{account_id}-"))
        .then(|| folder_key(account_id, folder_id))
}
