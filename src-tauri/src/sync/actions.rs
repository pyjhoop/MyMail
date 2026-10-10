//! 사용자 조작(읽음·별표·삭제·이동). 먼저 로컬 DB에 반영해 화면이 바로 바뀌게 하고,
//! 서버에 보낼 조작은 큐에 넣는다. 보내는 일은 `flush_pending`이 한다(연결이 없으면 나중에).

use super::SyncError;
use crate::providers::MailProvider;
use crate::store::{OpKind, Store};

fn flag_arg(on: bool) -> &'static str {
    if on {
        "1"
    } else {
        "0"
    }
}

/// 읽음 표시를 바꾼다. 조작이 일어난 계정 id를 돌려준다.
pub fn set_read(store: &Store, mail_id: &str, read: bool) -> Result<String, SyncError> {
    let mail = store.mail_ref(mail_id)?.ok_or(SyncError::MailNotFound)?;
    store.set_unread(mail_id, !read)?;
    store.enqueue(
        &mail.account_id,
        OpKind::Seen,
        &mail.folder_key,
        &mail.remote_id,
        flag_arg(read),
    )?;
    Ok(mail.account_id)
}

pub fn set_starred(store: &Store, mail_id: &str, starred: bool) -> Result<String, SyncError> {
    let mail = store.mail_ref(mail_id)?.ok_or(SyncError::MailNotFound)?;
    store.set_starred(mail_id, starred)?;
    store.enqueue(
        &mail.account_id,
        OpKind::Flagged,
        &mail.folder_key,
        &mail.remote_id,
        flag_arg(starred),
    )?;
    Ok(mail.account_id)
}

/// 메일을 지운다. 휴지통에 있는 메일은 완전히 지우고, 그 밖의 메일은 휴지통으로 옮긴다.
pub fn delete_mail(store: &Store, mail_id: &str) -> Result<String, SyncError> {
    let mail = store.mail_ref(mail_id)?.ok_or(SyncError::MailNotFound)?;
    if mail.folder_kind == "trash" {
        store.enqueue(
            &mail.account_id,
            OpKind::Delete,
            &mail.folder_key,
            &mail.remote_id,
            "",
        )?;
    } else {
        let (_, trash_key) = store
            .folder_of_kind(&mail.account_id, "trash")?
            .ok_or(SyncError::NoTrash)?;
        store.enqueue(
            &mail.account_id,
            OpKind::Move,
            &mail.folder_key,
            &mail.remote_id,
            &trash_key,
        )?;
    }
    store.remove_local(&mail)?;
    Ok(mail.account_id)
}

/// 휴지통·스팸함의 모든 메일을 완전히 지운다. 다른 폴더는 거절한다(받은편지함을 실수로 비우지 않게).
/// 로컬에서 먼저 비우고 서버 조작은 한 건으로 큐에 넣는다. 계정 id를 돌려준다.
pub fn empty_folder(store: &Store, account_id: &str, folder_id: &str) -> Result<String, SyncError> {
    let (kind, key) = store
        .folder_info(account_id, folder_id)?
        .ok_or(SyncError::FolderNotFound)?;
    if kind != "trash" && kind != "spam" {
        return Err(SyncError::NotEmptiable);
    }
    store.enqueue(account_id, OpKind::EmptyFolder, &key, "", "")?;
    store.clear_folder(account_id, folder_id)?;
    Ok(account_id.to_string())
}

/// 같은 계정의 다른 폴더로 옮긴다. 옮긴 메일은 서버가 새 번호를 매기므로, 대상 폴더를 동기화할 때 다시 나타난다.
pub fn move_mail(store: &Store, mail_id: &str, dest_folder_id: &str) -> Result<String, SyncError> {
    let mail = store.mail_ref(mail_id)?.ok_or(SyncError::MailNotFound)?;
    if dest_folder_id == mail.folder_id {
        return Ok(mail.account_id);
    }
    let (_, dest_key) = store
        .folder_info(&mail.account_id, dest_folder_id)?
        .ok_or(SyncError::FolderNotFound)?;
    store.enqueue(
        &mail.account_id,
        OpKind::Move,
        &mail.folder_key,
        &mail.remote_id,
        &dest_key,
    )?;
    store.remove_local(&mail)?;
    Ok(mail.account_id)
}

/// 보관은 받은편지함 등에서 메일을 치워 두는 동작이다. 이미 보관·휴지통·스팸·임시보관함에 있는 메일은 대상이 아니다.
const NOT_ARCHIVABLE: [&str; 4] = ["archive", "trash", "spam", "drafts"];

/// 메일을 이 계정의 보관 폴더로 옮긴다. Gmail은 전체보관함으로, 네이버는 "보관함" 폴더로 옮긴다.
/// 보관 폴더가 아직 없으면 서버에 만든다(`provider`가 있어야 한다). 계정 id를 돌려준다.
pub async fn archive_mail(
    store: &Store,
    provider: Option<&dyn MailProvider>,
    mail_id: &str,
) -> Result<String, SyncError> {
    let mail = store.mail_ref(mail_id)?.ok_or(SyncError::MailNotFound)?;
    if NOT_ARCHIVABLE.contains(&mail.folder_kind.as_str()) {
        return Err(SyncError::AlreadyArchived);
    }
    let dest_key = match store.folder_of_kind(&mail.account_id, "archive")? {
        Some((_, key)) => key,
        None => {
            let provider = provider.ok_or(SyncError::NotConnected)?;
            let name = provider
                .archive_folder_name()
                .ok_or(SyncError::ArchiveUnavailable)?;
            provider.create_folder(name).await?;
            // 만든 폴더가 목록에 보이도록 서버의 폴더 목록으로 맞춘다.
            let remote = provider.list_folders().await?;
            store.save_folders(&mail.account_id, &remote)?;
            store
                .folder_of_kind(&mail.account_id, "archive")?
                .ok_or(SyncError::ArchiveUnavailable)?
                .1
        }
    };
    store.enqueue(
        &mail.account_id,
        OpKind::Move,
        &mail.folder_key,
        &mail.remote_id,
        &dest_key,
    )?;
    store.remove_local(&mail)?;
    Ok(mail.account_id)
}
