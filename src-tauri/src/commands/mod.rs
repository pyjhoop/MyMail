//! Tauri command. 입력 검증과 서비스 호출만 한다.

use serde::Serialize;
use tauri::State;

use crate::store::{Account, Folder, MailDetail, MailSummary, Store, StoreError};

/// UI의 `LoadError`와 같은 모양.
#[derive(Debug, Serialize)]
pub struct CommandError {
    kind: &'static str,
    message: String,
}

impl From<StoreError> for CommandError {
    fn from(e: StoreError) -> Self {
        Self {
            kind: "unknown",
            message: e.to_string(),
        }
    }
}

type CommandResult<T> = Result<T, CommandError>;

#[tauri::command]
pub async fn list_accounts(store: State<'_, Store>) -> CommandResult<Vec<Account>> {
    Ok(store.list_accounts()?)
}

#[tauri::command]
pub async fn list_folders(
    store: State<'_, Store>,
    account_id: String,
) -> CommandResult<Vec<Folder>> {
    Ok(store.list_folders(&account_id)?)
}

/// `account_id`가 없으면 통합 받은편지함.
#[tauri::command]
pub async fn list_mails(
    store: State<'_, Store>,
    account_id: Option<String>,
    folder_id: String,
) -> CommandResult<Vec<MailSummary>> {
    Ok(store.list_mails(account_id.as_deref(), &folder_id)?)
}

#[tauri::command]
pub async fn get_mail(store: State<'_, Store>, id: String) -> CommandResult<Option<MailDetail>> {
    Ok(store.get_mail(&id)?)
}
