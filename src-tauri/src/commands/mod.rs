//! Tauri command. 입력 검증과 서비스 호출만 한다.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use std::sync::Arc;

use crate::auth::CredentialStore;
use crate::compose::{self, ComposeError};
use crate::providers::{self, MailProvider, ProviderError};
use crate::store::{
    Account, AddressSuggestion, ComposeInput, ComposeMail, Folder, MailDetail, MailSummary,
    NewAccount, Store, StoreError,
};
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

impl From<ComposeError> for CommandError {
    fn from(e: ComposeError) -> Self {
        let kind = match &e {
            ComposeError::Provider(ProviderError::Auth(_)) => "auth",
            ComposeError::Provider(ProviderError::Network(_)) => "network",
            _ => "unknown",
        };
        let message = match &e {
            ComposeError::Provider(ProviderError::Auth(m) | ProviderError::Network(m)) => m.clone(),
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

/// 제목·보낸사람·본문 검색. `account_id`가 없으면 모든 계정.
#[tauri::command]
pub async fn search_mails(
    store: State<'_, Store>,
    account_id: Option<String>,
    query: String,
) -> CommandResult<Vec<MailSummary>> {
    Ok(store.search_mails(account_id.as_deref(), &query)?)
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
    // 작성 중인 메일(임시보관함)은 서버에 없으므로 이 앱에서만 지운다.
    if compose::is_draft_id(&id) {
        store.delete_compose(&id)?;
        return Ok(());
    }
    let account_id = actions::delete_mail(&store, &id)?;
    manager.kick(&app, &account_id);
    Ok(())
}

/// 작성 내용을 저장한다(자동 저장). 없으면 만들고 있으면 덮어쓴다. 첨부는 건드리지 않는다.
#[tauri::command]
pub async fn save_draft(store: State<'_, Store>, draft: ComposeInput) -> CommandResult<()> {
    if !compose::is_draft_id(&draft.id) {
        return Err(invalid("작성 중인 메일 번호가 올바르지 않아요."));
    }
    store.save_compose(&draft)?;
    Ok(())
}

#[tauri::command]
pub async fn get_draft(store: State<'_, Store>, id: String) -> CommandResult<Option<ComposeMail>> {
    Ok(store.get_compose(&id)?)
}

/// 작성 중인 메일을 버린다. 첨부도 함께 지워진다.
#[tauri::command]
pub async fn discard_draft(store: State<'_, Store>, id: String) -> CommandResult<()> {
    store.delete_compose(&id)?;
    Ok(())
}

/// 첨부를 더하고 첨부 id를 돌려준다. `data`는 base64. 서비스의 용량 한도를 넘으면 거절한다.
#[tauri::command]
pub async fn add_draft_attachment(
    store: State<'_, Store>,
    id: String,
    name: String,
    mime: String,
    data: String,
) -> CommandResult<i64> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data.trim())
        .map_err(|_| invalid("첨부 파일을 읽지 못했어요."))?;
    Ok(compose::add_attachment(&store, &id, &name, &mime, &bytes)?)
}

#[tauri::command]
pub async fn remove_draft_attachment(
    store: State<'_, Store>,
    id: String,
    attachment_id: i64,
) -> CommandResult<()> {
    store.remove_compose_attachment(&id, attachment_id)?;
    Ok(())
}

/// 작성 중인 메일을 보낸다. 실패하면 메일은 `failed`로 남아 임시보관함에서 다시 보낼 수 있다.
#[tauri::command]
pub async fn send_draft(
    app: AppHandle,
    store: State<'_, Store>,
    manager: State<'_, SyncManager>,
    id: String,
) -> CommandResult<()> {
    let mail = store
        .get_compose(&id)?
        .ok_or_else(|| CommandError::from(ComposeError::NotFound))?;
    let Some(provider) = manager.provider(&mail.account_id) else {
        return Err(CommandError {
            kind: "auth",
            message: "이 계정에 연결할 수 없어요. 앱 비밀번호를 확인해 주세요.".into(),
        });
    };
    compose::send(&store, &*provider, &id).await?;
    manager.refresh_sent(&app, &mail.account_id);
    Ok(())
}

/// 받는사람 자동완성: 받은 메일의 보낸 사람과 보낸 메일의 받는 사람 중 `query`와 맞는 주소
#[tauri::command]
pub async fn suggest_addresses(
    store: State<'_, Store>,
    query: String,
) -> CommandResult<Vec<AddressSuggestion>> {
    Ok(store.suggest_addresses(&query)?)
}

#[tauri::command]
pub async fn set_signature(
    store: State<'_, Store>,
    account_id: String,
    signature: String,
) -> CommandResult<()> {
    store.set_signature(&account_id, signature.trim_end())?;
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
