//! 동기화 엔진. 계정 추가, 서버와 로컬 대조(전체 동기화·이어받기), 사용자 조작의 서버 반영(오프라인 큐).
//! 새 메일 감지 반복은 `manager`, 읽음·삭제·이동은 `actions`가 맡는다.

pub mod actions;
pub mod manager;

use std::cmp::Reverse;
use std::collections::HashSet;

use crate::auth::{AuthError, CredentialStore};
use crate::providers::{FolderKind, MailProvider, ProviderError, RemoteFolder};
use crate::store::{folder_key, NewAccount, OpKind, Store, StoreError};

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("이미 추가된 계정이에요")]
    Duplicate,
    #[error("메일을 찾을 수 없어요")]
    MailNotFound,
    #[error("휴지통 폴더를 찾을 수 없어요")]
    NoTrash,
    #[error("옮길 폴더를 찾을 수 없어요")]
    FolderNotFound,
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Provider(#[from] ProviderError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// 계정을 추가하는 순간 받는 받은편지함 메일 수. 화면을 빨리 띄우기 위해 작게 둔다.
const FIRST_LOGIN_FETCH_LIMIT: usize = 30;
/// 동기화할 때 폴더마다 먼저 받는 최신 메일 수. 큰 폴더 하나가 다른 폴더를 오래 막지 않게 한다.
const FIRST_PASS_PER_FOLDER: usize = 100;
/// 한 번의 서버 요청으로 받는 메일 수. 연결을 새로 맺는 횟수와 메모리 사용의 균형이다.
const FETCH_BATCH: usize = 100;

/// 동기화 진행 상황. UI가 진행률 막대로 보여 준다. `done`/`total`은 받을 메일 수다.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub account_id: String,
    pub done: usize,
    pub total: usize,
    /// 중간에 실패했을 때의 안내. 이미 받은 메일은 남는다.
    pub error: Option<String>,
}

/// 동기화할 폴더 범위
#[derive(Debug, Clone, Copy)]
pub enum Scope<'a> {
    /// 폴더 목록을 새로 읽고 모든 폴더를 맞춘다.
    All,
    /// 지정한 서버 key의 폴더만 맞춘다(새 메일 알림을 받았을 때 등).
    Folders(&'a [String]),
}

/// 폴더 목록을 저장하고 받은편지함만 먼저 가져온다. 나머지는 `sync_account`가 받는다.
async fn ingest_first(
    store: &Store,
    account_id: &str,
    provider: &dyn MailProvider,
) -> Result<Vec<RemoteFolder>, SyncError> {
    let folders = provider.list_folders().await?;
    store.save_folders(account_id, &folders)?;
    if let Some(inbox) = folders.iter().find(|f| f.kind == FolderKind::Inbox) {
        let messages = provider
            .fetch_messages(&inbox.key, FIRST_LOGIN_FETCH_LIMIT)
            .await?;
        store.save_messages(account_id, &inbox.key, &messages)?;
    }
    Ok(folders)
}

/// 자격 증명을 확인하고 계정을 등록한 뒤 받은편지함 첫 메일을 가져온다. 폴더 목록을 돌려준다.
/// 중간에 실패하면 저장한 계정과 비밀번호를 되돌려, 반쯤 추가된 계정이 남지 않게 한다.
pub async fn add_account(
    store: &Store,
    credentials: &dyn CredentialStore,
    provider: &dyn MailProvider,
    account: NewAccount,
    password: &str,
) -> Result<Vec<RemoteFolder>, SyncError> {
    if store.account_email_exists(&account.email)? {
        return Err(SyncError::Duplicate);
    }
    provider.verify().await?;
    credentials.save(&account.id, password)?;
    let result = async {
        store.insert_account(&account)?;
        ingest_first(store, &account.id, provider).await
    }
    .await;
    if result.is_err() {
        store.delete_account(&account.id)?;
        credentials.delete(&account.id)?;
    }
    result
}

/// 서버에 보내지 못한 조작을 만든 순서대로 보낸다. 이동한 메일의 대상 폴더 key를 돌려준다.
/// 서버가 거절한 조작(없는 메일 등)은 버리고, 연결 오류는 그 자리에서 멈춰 큐를 그대로 둔다.
pub async fn flush_pending(
    store: &Store,
    provider: &dyn MailProvider,
    account_id: &str,
) -> Result<Vec<String>, SyncError> {
    let mut moved_to = Vec::new();
    for op in store.pending_ops(account_id)? {
        let result = match op.kind {
            OpKind::Seen => {
                provider
                    .set_seen(&op.folder_key, &op.remote_id, op.arg == "1")
                    .await
            }
            OpKind::Flagged => {
                provider
                    .set_flagged(&op.folder_key, &op.remote_id, op.arg == "1")
                    .await
            }
            OpKind::Move => {
                provider
                    .move_message(&op.folder_key, &op.remote_id, &op.arg)
                    .await
            }
            OpKind::Delete => provider.delete_message(&op.folder_key, &op.remote_id).await,
        };
        match result {
            Ok(()) => {
                if op.kind == OpKind::Move && !moved_to.contains(&op.arg) {
                    moved_to.push(op.arg.clone());
                }
            }
            Err(ProviderError::Rejected(_) | ProviderError::NotFound(_)) => {}
            Err(e) => return Err(e.into()),
        }
        store.finish_op(op.id)?;
    }
    Ok(moved_to)
}

/// 폴더 하나를 서버와 대조한 결과, 아직 받지 못한 메일
struct FolderPlan {
    folder_key: String,
    /// 최신(UID가 큰) 것부터
    missing: Vec<String>,
}

/// 서버 상태를 로컬에 맞춘다: 사라진 메일 삭제, 바뀐 읽음·별표 반영, UIDVALIDITY가 바뀌면 폴더 초기화.
/// 받아야 할 메일 목록을 돌려준다(받는 일은 호출한 쪽이 한다).
async fn plan_folder(
    store: &Store,
    provider: &dyn MailProvider,
    account_id: &str,
    folder_id: &str,
) -> Result<FolderPlan, SyncError> {
    let key = folder_key(account_id, folder_id);
    let snapshot = provider.snapshot(&key).await?;

    let stored = store.uid_validity(folder_id)?;
    if stored.is_some() && snapshot.uid_validity.is_some() && stored != snapshot.uid_validity {
        store.clear_folder(account_id, folder_id)?;
    }
    if snapshot.uid_validity.is_some() && snapshot.uid_validity != stored {
        store.set_uid_validity(folder_id, snapshot.uid_validity)?;
    }

    let known = store.known_uids(folder_id)?;
    let on_server: HashSet<&str> = snapshot
        .messages
        .iter()
        .map(|m| m.remote_id.as_str())
        .collect();

    let gone: Vec<String> = known
        .iter()
        .filter(|id| !on_server.contains(id.as_str()))
        .cloned()
        .collect();
    store.remove_remote(account_id, folder_id, &gone)?;

    // 서버에 아직 보내지 못한 조작이 걸린 메일은 로컬 상태가 더 새롭다.
    let local = store.local_flags(folder_id)?;
    let pending = store.pending_remote_ids(account_id, &key)?;
    let changed: Vec<_> = snapshot
        .messages
        .iter()
        .filter(|m| {
            local
                .get(&m.remote_id)
                .is_some_and(|flags| *flags != (m.unread, m.starred))
                && !pending.contains(&m.remote_id)
        })
        .cloned()
        .collect();
    store.apply_flags(folder_id, &changed)?;

    // 지운 메일이 풀어 준 중복 사본이 있을 수 있어 기록을 다시 읽는다.
    let known = store.known_uids(folder_id)?;
    let mut missing: Vec<String> = snapshot
        .messages
        .into_iter()
        .map(|m| m.remote_id)
        .filter(|id| !known.contains(id))
        .collect();
    missing.sort_by_key(|id| Reverse(id.parse::<u64>().unwrap_or(0)));
    Ok(FolderPlan {
        folder_key: key,
        missing,
    })
}

struct Tracker<'a, F: Fn(Progress)> {
    account_id: &'a str,
    done: usize,
    total: usize,
    report: F,
}

impl<F: Fn(Progress)> Tracker<'_, F> {
    fn emit(&self, error: Option<String>) {
        (self.report)(Progress {
            account_id: self.account_id.into(),
            done: self.done,
            total: self.total,
            error,
        });
    }
}

/// 서버와 로컬을 맞춘다. 먼저 보내지 못한 조작을 보내고, 폴더마다 UID를 대조해 새 메일은 받고 사라진 메일은 지운다.
/// 이미 받은 UID는 건너뛰므로 중간에 끊겨도 다음 실행이 남은 것부터 이어받는다.
/// 진행 상황은 `report`로 알리며, 끝나면(받을 게 없어도) `done == total`인 알림을 한 번 보낸다.
/// 실패하면 오류가 담긴 알림을 보내고 같은 오류를 돌려준다.
pub async fn sync_account(
    store: &Store,
    provider: &dyn MailProvider,
    account_id: &str,
    scope: Scope<'_>,
    report: impl Fn(Progress),
) -> Result<(), SyncError> {
    let mut tracker = Tracker {
        account_id,
        done: 0,
        total: 0,
        report,
    };
    let result = run_sync(store, provider, account_id, scope, &mut tracker).await;
    match &result {
        Ok(()) => tracker.emit(None),
        Err(e) => tracker.emit(Some(user_message(e))),
    }
    result
}

async fn run_sync<F: Fn(Progress)>(
    store: &Store,
    provider: &dyn MailProvider,
    account_id: &str,
    scope: Scope<'_>,
    tracker: &mut Tracker<'_, F>,
) -> Result<(), SyncError> {
    flush_pending(store, provider, account_id).await?;
    if matches!(scope, Scope::All) {
        let folders = provider.list_folders().await?;
        store.save_folders(account_id, &folders)?;
    }

    let mut plans = Vec::new();
    for folder in store.list_folders(account_id)? {
        let key = folder_key(account_id, &folder.id);
        if let Scope::Folders(keys) = scope {
            if !keys.contains(&key) {
                continue;
            }
        }
        plans.push(plan_folder(store, provider, account_id, &folder.id).await?);
    }
    tracker.total = plans.iter().map(|p| p.missing.len()).sum();
    if tracker.total > 0 {
        tracker.emit(None);
    }

    // 폴더마다 최신 메일을 먼저 받고, 나머지는 그 뒤에 받는다.
    let mut rest = Vec::new();
    for plan in plans {
        let (head, tail) = plan
            .missing
            .split_at(plan.missing.len().min(FIRST_PASS_PER_FOLDER));
        download(store, provider, account_id, &plan.folder_key, head, tracker).await?;
        rest.push((plan.folder_key, tail.to_vec()));
    }
    for (key, ids) in rest {
        download(store, provider, account_id, &key, &ids, tracker).await?;
    }
    Ok(())
}

async fn download<F: Fn(Progress)>(
    store: &Store,
    provider: &dyn MailProvider,
    account_id: &str,
    folder_key: &str,
    ids: &[String],
    tracker: &mut Tracker<'_, F>,
) -> Result<(), SyncError> {
    for batch in ids.chunks(FETCH_BATCH) {
        let messages = provider.fetch_by_ids(folder_key, batch).await?;
        store.save_messages(account_id, folder_key, &messages)?;
        tracker.done += batch.len();
        tracker.emit(None);
    }
    Ok(())
}

/// 진행 알림에 담는 사용자용 오류 문구
fn user_message(e: &SyncError) -> String {
    match e {
        SyncError::Provider(ProviderError::Auth(m) | ProviderError::Network(m)) => m.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests;
