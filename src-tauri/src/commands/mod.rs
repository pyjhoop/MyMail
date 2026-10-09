//! Tauri command. 입력 검증과 서비스 호출만 한다.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use std::sync::Arc;

use crate::auth::CredentialStore;
use crate::providers::{self, MailProvider, ProviderError};
use crate::store::{Account, Folder, MailDetail, MailSummary, NewAccount, Store, StoreError};
use crate::sync::manager::SyncManager;
use crate::sync::{self, actions, SyncError};

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

impl From<SyncError> for CommandError {
    fn from(e: SyncError) -> Self {
        let kind = match &e {
            SyncError::Provider(ProviderError::Auth(_)) => "auth",
            SyncError::Provider(ProviderError::Network(_)) => "network",
            _ => "unknown",
        };
        let message = match &e {
            SyncError::Provider(ProviderError::Auth(m) | ProviderError::Network(m)) => m.clone(),
            other => other.to_string(),
        };
        Self { kind, message }
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

/// 접속을 확인하고 계정을 추가한다. 성공하면 추가된 계정을 돌려준다.
#[tauri::command]
pub async fn add_account(
    app: AppHandle,
    store: State<'_, Store>,
    credentials: State<'_, Arc<dyn CredentialStore>>,
    provider: String,
    email: String,
    password: String,
    name: Option<String>,
) -> CommandResult<Account> {
    let email = email.trim().to_string();
    let password = password.trim().to_string();
    if !email.contains('@') {
        return Err(invalid("이메일 주소를 확인해 주세요."));
    }
    if password.is_empty() {
        return Err(invalid("비밀번호를 입력해 주세요."));
    }
    let remote: Arc<dyn MailProvider> = providers::create(&provider, &email, &password)
        .map_err(|e| invalid(&e.to_string()))?
        .into();

    let account = NewAccount {
        id: format!("{provider}-{}", crate::unix_millis()),
        name: name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| email.clone()),
        email,
        provider,
        color_index: (store.account_count()? % 8) as u8 + 1,
    };
    let id = account.id.clone();
    sync::add_account(
        &store,
        credentials.inner().as_ref(),
        &*remote,
        account,
        &password,
    )
    .await?;

    // 나머지 폴더는 화면을 막지 않고 백그라운드로 받으면서 진행 상황을 UI에 알린다.
    app.state::<SyncManager>().start(&app, &id, remote);
    store
        .list_accounts()?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| invalid("추가한 계정을 찾을 수 없어요."))
}

/// 읽음 표시를 바꾼다. 화면은 바로 바뀌고, 서버에는 백그라운드로 반영한다.
#[tauri::command]
pub async fn set_read(
    app: AppHandle,
    store: State<'_, Store>,
    manager: State<'_, SyncManager>,
    id: String,
    read: bool,
) -> CommandResult<()> {
    let account_id = actions::set_read(&store, &id, read)?;
    manager.kick(&app, &account_id);
    Ok(())
}

#[tauri::command]
pub async fn set_starred(
    app: AppHandle,
    store: State<'_, Store>,
    manager: State<'_, SyncManager>,
    id: String,
    starred: bool,
) -> CommandResult<()> {
    let account_id = actions::set_starred(&store, &id, starred)?;
    manager.kick(&app, &account_id);
    Ok(())
}

/// 휴지통 밖의 메일은 휴지통으로, 휴지통 안의 메일은 완전히 지운다.
#[tauri::command]
pub async fn delete_mail(
    app: AppHandle,
    store: State<'_, Store>,
    manager: State<'_, SyncManager>,
    id: String,
) -> CommandResult<()> {
    let account_id = actions::delete_mail(&store, &id)?;
    manager.kick(&app, &account_id);
    Ok(())
}

/// 같은 계정의 다른 폴더로 옮긴다.
#[tauri::command]
pub async fn move_mail(
    app: AppHandle,
    store: State<'_, Store>,
    manager: State<'_, SyncManager>,
    id: String,
    folder_id: String,
) -> CommandResult<()> {
    let account_id = actions::move_mail(&store, &id, &folder_id)?;
    manager.kick(&app, &account_id);
    Ok(())
}

fn invalid(message: &str) -> CommandError {
    CommandError {
        kind: "unknown",
        message: message.into(),
    }
}
