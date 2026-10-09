//! 사용자 조작(읽음·별표·삭제·이동). 먼저 로컬 DB에 반영해 화면이 바로 바뀌게 하고,
//! 서버에 보낼 조작은 큐에 넣는다. 보내는 일은 `flush_pending`이 한다(연결이 없으면 나중에).

use super::SyncError;
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
