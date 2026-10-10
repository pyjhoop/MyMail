//! 라벨 조작: 메일에 붙이기·떼기(로컬 먼저, 서버는 큐), 라벨 만들기·이름 바꾸기·삭제(서버에 바로).
//! 라벨이 없는 서비스(네이버)는 `supports_labels()`가 false라 모두 거절한다. 서비스별 분기는 provider 안에 있다.

use super::SyncError;
use crate::providers::MailProvider;
use crate::store::{folder_id, OpKind, PendingOp, Store};

/// 라벨 전체 이름의 최대 글자 수
pub const MAX_LABEL_CHARS: usize = 100;

/// 라벨 이름을 다듬고 검증한다. 시스템 폴더 이름·예약 이름·금지 문자·너무 긴 이름은 거절한다.
/// 계층은 `부모/자식` 꼴이다.
pub fn validate_label_name(
    store: &Store,
    account_id: &str,
    raw: &str,
) -> Result<String, SyncError> {
    let name = raw.trim();
    let invalid = |m: &str| Err(SyncError::InvalidLabel(m.into()));
    if name.is_empty() {
        return invalid("라벨 이름을 입력해 주세요.");
    }
    if name.chars().count() > MAX_LABEL_CHARS {
        return invalid("라벨 이름은 100자 이하로 입력해 주세요.");
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '\\' | '"' | '*' | '%'))
    {
        return invalid("라벨 이름에 쓸 수 없는 문자가 있어요. (\\ \" * %)");
    }
    if name
        .split('/')
        .any(|part| part.trim() != part || part.is_empty())
    {
        return invalid(
            "라벨 이름의 `/` 앞뒤에는 이름이 있어야 하고 공백으로 시작하거나 끝날 수 없어요.",
        );
    }
    let first = name.split('/').next().unwrap_or(name);
    if first.eq_ignore_ascii_case("INBOX") || first.starts_with('[') {
        return invalid("시스템 폴더 이름은 라벨로 쓸 수 없어요.");
    }
    let lower = name.to_lowercase();
    if store
        .non_label_folder_names(account_id)?
        .iter()
        .any(|n| n.to_lowercase() == lower)
    {
        return invalid("시스템 폴더 이름은 라벨로 쓸 수 없어요.");
    }
    Ok(name.to_string())
}

/// 메일에 라벨을 붙이거나 뗀다. `mail_ids`는 모두 같은 계정의 메일이어야 한다.
/// 로컬 표시를 먼저 바꾸고 서버 조작은 큐에 넣는다(`flush_pending`이 보낸다). 계정 id를 돌려준다.
/// 하나라도 검증에 실패하면 아무것도 바꾸지 않는다.
pub fn change_labels(
    store: &Store,
    provider: &dyn MailProvider,
    mail_ids: &[String],
    label: &str,
    add: bool,
) -> Result<String, SyncError> {
    let mut mails = Vec::with_capacity(mail_ids.len());
    for id in mail_ids {
        mails.push((id, store.mail_ref(id)?.ok_or(SyncError::MailNotFound)?));
    }
    let Some((_, first)) = mails.first() else {
        return Err(SyncError::MailNotFound);
    };
    let account_id = first.account_id.clone();
    if mails.iter().any(|(_, m)| m.account_id != account_id) {
        return Err(SyncError::InvalidLabel(
            "서로 다른 계정의 메일에는 한 번에 라벨을 붙일 수 없어요.".into(),
        ));
    }
    if !provider.supports_labels() {
        return Err(SyncError::LabelsUnsupported);
    }
    let label = if add {
        let name = validate_label_name(store, &account_id, label)?;
        store
            .label_folder(&account_id, &name)?
            .ok_or(SyncError::LabelNotFound)?;
        name
    } else {
        label.trim().to_string()
    };
    let kind = if add {
        OpKind::AddLabel
    } else {
        OpKind::RemoveLabel
    };
    for (id, mail) in &mails {
        let mut labels = store.mail_labels(id)?.ok_or(SyncError::MailNotFound)?;
        let has = labels.contains(&label);
        if has == add {
            continue;
        }
        if add {
            labels.push(label.clone());
        } else {
            labels.retain(|l| *l != label);
        }
        store.set_mail_labels(id, &labels)?;
        store.enqueue(&account_id, kind, &mail.folder_key, &mail.remote_id, &label)?;
    }
    Ok(account_id)
}

/// 서버가 거절한 라벨 조작을 로컬 표시에서 되돌린다. 라벨 조작이 아니면 아무것도 하지 않는다.
pub fn revert_label_op(store: &Store, account_id: &str, op: &PendingOp) -> Result<(), SyncError> {
    if !matches!(op.kind, OpKind::AddLabel | OpKind::RemoveLabel) {
        return Ok(());
    }
    let id = format!("{}-{}", folder_id(account_id, &op.folder_key), op.remote_id);
    let Some(mut labels) = store.mail_labels(&id)? else {
        return Ok(());
    };
    match op.kind {
        OpKind::AddLabel => labels.retain(|l| *l != op.arg),
        _ => {
            if !labels.contains(&op.arg) {
                labels.push(op.arg.clone());
            }
        }
    }
    store.set_mail_labels(&id, &labels)?;
    Ok(())
}

/// 서버의 폴더 목록으로 로컬 폴더(라벨)를 맞춘다.
async fn refresh_folders(
    store: &Store,
    provider: &dyn MailProvider,
    account_id: &str,
) -> Result<(), SyncError> {
    let remote = provider.list_folders().await?;
    store.save_folders(account_id, &remote)?;
    Ok(())
}

fn require_labels(provider: &dyn MailProvider) -> Result<(), SyncError> {
    if provider.supports_labels() {
        Ok(())
    } else {
        Err(SyncError::LabelsUnsupported)
    }
}

/// 라벨을 서버에 만들고 로컬 폴더 목록에 더한다. 이미 있으면 그 폴더 id를 돌려준다.
pub async fn create_label(
    store: &Store,
    provider: &dyn MailProvider,
    account_id: &str,
    raw_name: &str,
) -> Result<String, SyncError> {
    require_labels(provider)?;
    let name = validate_label_name(store, account_id, raw_name)?;
    if let Some((id, _)) = store.label_folder(account_id, &name)? {
        return Ok(id);
    }
    provider.create_label(&name).await?;
    refresh_folders(store, provider, account_id).await?;
    let (id, _) = store
        .label_folder(account_id, &name)?
        .ok_or(SyncError::LabelNotFound)?;
    Ok(id)
}

/// 라벨 이름을 바꾼다(하위 라벨 포함). 메일에 붙은 라벨 이름도 함께 바꾼다.
pub async fn rename_label(
    store: &Store,
    provider: &dyn MailProvider,
    account_id: &str,
    folder_id: &str,
    raw_new: &str,
) -> Result<(), SyncError> {
    require_labels(provider)?;
    let old = store
        .label_path_of(account_id, folder_id)?
        .ok_or(SyncError::LabelNotFound)?;
    let new = validate_label_name(store, account_id, raw_new)?;
    if new == old {
        return Ok(());
    }
    if new.starts_with(&format!("{old}/")) || store.label_folder(account_id, &new)?.is_some() {
        return Err(SyncError::InvalidLabel("이미 있는 라벨 이름이에요.".into()));
    }
    provider.rename_label(&old, &new).await?;
    let prefix = format!("{old}/");
    store.rewrite_labels(account_id, |l| {
        if l == old {
            Some(new.clone())
        } else {
            l.strip_prefix(&prefix)
                .map(|rest| format!("{new}/{rest}"))
                .or_else(|| Some(l.to_string()))
        }
    })?;
    refresh_folders(store, provider, account_id).await
}

/// 라벨을 지운다. 메일은 지워지지 않고 라벨만 떨어진다.
pub async fn delete_label(
    store: &Store,
    provider: &dyn MailProvider,
    account_id: &str,
    folder_id: &str,
) -> Result<(), SyncError> {
    require_labels(provider)?;
    let name = store
        .label_path_of(account_id, folder_id)?
        .ok_or(SyncError::LabelNotFound)?;
    provider.delete_label(&name).await?;
    store.rewrite_labels(account_id, |l| (l != name).then(|| l.to_string()))?;
    refresh_folders(store, provider, account_id).await
}

#[cfg(test)]
mod tests;
