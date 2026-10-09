//! 메일 작성·발송. 작성 중인 메일은 `store`의 compose_mails에 두고, 보내기에 성공하면 지운다.
//! 실패하면 `failed`로 남겨 임시보관함에서 다시 보낼 수 있게 한다.

use crate::providers::{MailProvider, OutgoingAttachment, OutgoingMail, ProviderError};
use crate::store::{Store, StoreError};

/// 작성 중인 메일의 id는 항상 이 접두사로 시작한다. 서버 메일 id와 겹치지 않는다.
pub const DRAFT_PREFIX: &str = "draft:";

pub fn is_draft_id(id: &str) -> bool {
    id.starts_with(DRAFT_PREFIX)
}

#[derive(Debug, thiserror::Error)]
pub enum ComposeError {
    #[error("작성 중인 메일을 찾을 수 없어요")]
    NotFound,
    #[error("받는사람을 입력해 주세요")]
    NoRecipients,
    #[error("올바르지 않은 메일 주소예요: {0}")]
    InvalidAddress(String),
    #[error("첨부 용량이 너무 커요. 이 계정은 메일 한 통에 최대 {limit_mb}MB까지 보낼 수 있어요")]
    TooLarge { limit_mb: u64 },
    #[error("보내는 계정을 찾을 수 없어요")]
    NoAccount,
    #[error(transparent)]
    Provider(#[from] ProviderError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// 주소 목록의 각 항목에 `@`가 있는지만 본다. 자세한 검증은 발송할 때 서버 쪽 규칙으로 한다.
fn check_addresses(list: &[String]) -> Result<(), ComposeError> {
    for raw in list {
        let (_, email) = crate::store::split_address(raw);
        let ok = email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'));
        if !ok {
            return Err(ComposeError::InvalidAddress(raw.trim().to_string()));
        }
    }
    Ok(())
}

/// base64 인코딩으로 늘어나는 비율(4/3)과 헤더를 감안해, 첨부 원본 크기는 한도의 3/4까지만 허용한다.
fn attachment_budget(limit: u64) -> u64 {
    limit / 4 * 3
}

/// 작성 중인 메일에 첨부를 더한다. 한도를 넘으면 거절하고 저장하지 않는다.
pub fn add_attachment(
    store: &Store,
    mail_id: &str,
    name: &str,
    mime: &str,
    data: &[u8],
) -> Result<i64, ComposeError> {
    let mail = store.get_compose(mail_id)?.ok_or(ComposeError::NotFound)?;
    let (_, _, provider) = store
        .account_identity(&mail.account_id)?
        .ok_or(ComposeError::NoAccount)?;
    if let Some(limit) = crate::providers::message_size_limit(&provider) {
        let total = store.compose_attachment_bytes(mail_id)? + data.len() as u64;
        if total > attachment_budget(limit) {
            return Err(ComposeError::TooLarge {
                limit_mb: limit / (1024 * 1024),
            });
        }
    }
    let mime = if mime.trim().is_empty() {
        "application/octet-stream"
    } else {
        mime
    };
    Ok(store.add_compose_attachment(mail_id, name, mime, data)?)
}

/// 작성 중인 메일을 보낸다. 성공하면 지우고, 실패하면 `failed`로 표시해 남긴다.
pub async fn send(
    store: &Store,
    provider: &dyn MailProvider,
    mail_id: &str,
) -> Result<(), ComposeError> {
    let mail = store.get_compose(mail_id)?.ok_or(ComposeError::NotFound)?;
    if mail.to.iter().chain(&mail.cc).chain(&mail.bcc).count() == 0 {
        return Err(ComposeError::NoRecipients);
    }
    check_addresses(&mail.to)?;
    check_addresses(&mail.cc)?;
    check_addresses(&mail.bcc)?;
    let (from_name, from_email, _) = store
        .account_identity(&mail.account_id)?
        .ok_or(ComposeError::NoAccount)?;

    let outgoing = OutgoingMail {
        from_name,
        from_email,
        to: mail.to,
        cc: mail.cc,
        bcc: mail.bcc,
        subject: mail.subject,
        body: mail.body,
        attachments: store
            .compose_attachment_data(mail_id)?
            .into_iter()
            .map(|a| OutgoingAttachment {
                name: a.name,
                mime: a.mime,
                data: a.data,
            })
            .collect(),
    };
    match provider.send(&outgoing).await {
        Ok(()) => {
            store.delete_compose(mail_id)?;
            Ok(())
        }
        Err(e) => {
            store.set_compose_failed(mail_id, &e.to_string())?;
            Err(e.into())
        }
    }
}

#[cfg(test)]
mod tests;
