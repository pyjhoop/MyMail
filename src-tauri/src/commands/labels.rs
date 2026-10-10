//! 라벨 command. 입력 검증과 큐잉은 `sync::labels`가 한다.

use std::collections::BTreeMap;

use tauri::{AppHandle, State};

use super::{provider_for, CommandResult};
use crate::store::{Folder, Store};
use crate::sync::labels as label_ops;
use crate::sync::manager::SyncManager;
use crate::sync::SyncError;

/// 이 계정이 메일에 라벨을 붙일 수 있는지. 아니면 UI는 라벨 메뉴를 숨긴다(서비스별 분기는 백엔드가 한다).
#[tauri::command]
pub async fn supports_labels(
    manager: State<'_, SyncManager>,
    account_id: String,
) -> CommandResult<bool> {
    Ok(manager
        .provider(&account_id)
        .is_some_and(|p| p.supports_labels()))
}

/// 메일에 라벨을 붙인다. 여러 메일을 한 번에 처리한다.
#[tauri::command]
pub async fn add_label(
    app: AppHandle,
    store: State<'_, Store>,
    manager: State<'_, SyncManager>,
    ids: Vec<String>,
    label: String,
) -> CommandResult<()> {
    change(&app, &store, &manager, &ids, &label, true)
}

/// 메일에서 라벨을 뗀다(메일은 남는다).
#[tauri::command]
pub async fn remove_label(
    app: AppHandle,
    store: State<'_, Store>,
    manager: State<'_, SyncManager>,
    ids: Vec<String>,
    label: String,
) -> CommandResult<()> {
    change(&app, &store, &manager, &ids, &label, false)
}

fn change(
    app: &AppHandle,
    store: &Store,
    manager: &SyncManager,
    ids: &[String],
    label: &str,
    add: bool,
) -> CommandResult<()> {
    // 계정마다 라벨이 다르므로 계정별로 나눠 처리한다.
    let mut by_account: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in ids {
        let mail = store.mail_ref(id)?.ok_or(SyncError::MailNotFound)?;
        by_account
            .entry(mail.account_id)
            .or_default()
            .push(id.clone());
    }
    for (account_id, ids) in by_account {
        let provider = provider_for(manager, &account_id)?;
        label_ops::change_labels(store, &*provider, &ids, label, add)?;
        manager.kick(app, &account_id);
    }
    Ok(())
}

/// 라벨을 서버에 만든다. 만든 라벨(폴더)을 돌려준다.
#[tauri::command]
pub async fn create_label(
    store: State<'_, Store>,
    manager: State<'_, SyncManager>,
    account_id: String,
    name: String,
) -> CommandResult<Folder> {
    let provider = provider_for(&manager, &account_id)?;
    let id = label_ops::create_label(&store, &*provider, &account_id, &name).await?;
    store
        .list_folders(&account_id)?
        .into_iter()
        .find(|f| f.id == id)
        .ok_or_else(|| SyncError::LabelNotFound.into())
}

/// 라벨 이름을 바꾼다(하위 라벨 포함).
#[tauri::command]
pub async fn rename_label(
    app: AppHandle,
    store: State<'_, Store>,
    manager: State<'_, SyncManager>,
    account_id: String,
    folder_id: String,
    name: String,
) -> CommandResult<()> {
    let provider = provider_for(&manager, &account_id)?;
    label_ops::rename_label(&store, &*provider, &account_id, &folder_id, &name).await?;
    // 서버가 폴더 key를 바꾸므로 새 폴더의 메일을 다시 받는다.
    manager.kick(&app, &account_id);
    Ok(())
}

/// 라벨을 지운다. 메일은 지워지지 않는다.
#[tauri::command]
pub async fn delete_label(
    app: AppHandle,
    store: State<'_, Store>,
    manager: State<'_, SyncManager>,
    account_id: String,
    folder_id: String,
) -> CommandResult<()> {
    let provider = provider_for(&manager, &account_id)?;
    label_ops::delete_label(&store, &*provider, &account_id, &folder_id).await?;
    manager.kick(&app, &account_id);
    Ok(())
}
