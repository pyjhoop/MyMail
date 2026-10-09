//! 첨부파일 저장. 서버에서 내용을 받아 사용자가 고른 위치에 쓴다.
//! 저장 위치를 고르는 일(대화상자)은 호출한 쪽이 클로저로 넘겨서, 여기서는 UI 없이 시험할 수 있다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::providers::{AttachmentData, MailProvider, ProviderError};
use crate::store::{AttachmentRef, Store, StoreError};

/// 파일 이름이 비었을 때 쓰는 이름
const FALLBACK_NAME: &str = "첨부파일";
/// 정리한 파일 이름의 최대 글자 수(확장자 포함). Windows 경로 길이 제한을 넉넉히 피한다.
const MAX_NAME_CHARS: usize = 120;

#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
    #[error("첨부파일을 찾을 수 없어요.")]
    NotFound,
    #[error(transparent)]
    Provider(#[from] ProviderError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("파일을 저장하지 못했어요: {0}")]
    Io(String),
}

impl AttachmentError {
    /// UI에 보여 줄 한국어 안내. 오프라인과 서버 오류를 구분한다.
    pub fn user_message(&self) -> String {
        match self {
            Self::Provider(ProviderError::Network(_)) => {
                "서버에 연결할 수 없어 첨부파일을 받지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."
                    .into()
            }
            Self::Provider(ProviderError::Auth(_)) => {
                "로그인이 거부됐어요. 앱 비밀번호를 확인해 주세요.".into()
            }
            Self::Provider(ProviderError::NotFound(_) | ProviderError::Rejected(_)) => {
                "서버에서 첨부파일을 찾을 수 없어요. 메일이 이동되었거나 지워졌을 수 있어요.".into()
            }
            Self::Provider(ProviderError::Unsupported(_)) => {
                "이 계정에서는 첨부파일을 받을 수 없어요.".into()
            }
            other => other.to_string(),
        }
    }

    /// UI의 `LoadError.kind`
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Provider(ProviderError::Network(_)) => "network",
            Self::Provider(ProviderError::Auth(_)) => "auth",
            _ => "unknown",
        }
    }
}

/// 저장 결과. 대화상자를 닫으면 오류가 아니라 `Cancelled`다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveOutcome {
    Cancelled,
    /// 저장한 파일 수
    Saved {
        count: usize,
    },
}

/// 방금 저장한 파일 위치. "폴더에서 보기"가 쓴다. UI는 경로를 모르고 키만 안다.
#[derive(Default)]
pub struct SavedFiles(Mutex<HashMap<String, PathBuf>>);

impl SavedFiles {
    pub fn remember(&self, key: String, path: PathBuf) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(key, path);
        }
    }

    pub fn get(&self, key: &str) -> Option<PathBuf> {
        self.0.lock().ok().and_then(|m| m.get(key).cloned())
    }
}

pub fn saved_key(mail_id: &str, attachment_id: Option<i64>) -> String {
    match attachment_id {
        Some(id) => format!("{mail_id}/{id}"),
        None => format!("{mail_id}/*"),
    }
}

/// 메일에서 온 파일 이름을 안전한 이름으로 바꾼다. 메일 안 내용은 신뢰하지 않는다.
/// 경로 구분자·`..`·제어 문자·Windows 예약 문자와 예약 이름, 끝의 점·공백을 정리한다.
pub fn sanitize_file_name(name: &str) -> String {
    // 경로가 섞여 있으면 마지막 조각만 쓴다.
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = last
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut cleaned = cleaned
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string();
    if cleaned.is_empty() {
        return FALLBACK_NAME.into();
    }
    if cleaned.chars().count() > MAX_NAME_CHARS {
        cleaned = shorten(&cleaned);
    }
    if is_reserved(&cleaned) {
        cleaned.insert(0, '_');
    }
    cleaned
}

/// 확장자는 남기고 앞부분을 줄인다.
fn shorten(name: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if name.len() - i <= 16 && i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let keep = MAX_NAME_CHARS.saturating_sub(ext.chars().count());
    let stem: String = stem.chars().take(keep).collect();
    format!("{}{ext}", stem.trim_end_matches(['.', ' ']))
}

/// CON, NUL, COM1 같은 Windows 예약 이름(확장자가 붙어도 예약이다)
fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let stem = stem.trim_end();
    matches!(stem, "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// `dir` 안에서 겹치지 않는 경로. 이미 있으면 `이름 (1).확장자`, `(2)` … 를 붙인다.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn write_file(path: &Path, data: &[u8]) -> Result<(), AttachmentError> {
    std::fs::write(path, data).map_err(|e| AttachmentError::Io(e.to_string()))
}

async fn write_blocking(path: PathBuf, data: Vec<u8>) -> Result<(), AttachmentError> {
    tokio::task::spawn_blocking(move || write_file(&path, &data))
        .await
        .map_err(|e| AttachmentError::Io(e.to_string()))?
}

/// 첨부 하나를 `choose`가 고른 경로에 저장한다. `choose`는 기본 파일 이름(정리된 것)을 받고,
/// 취소하면 `None`을 돌려준다. 취소하면 서버에 접속하지도 파일을 쓰지도 않는다.
/// 저장한 경로는 `Ok((결과, 경로))`의 경로로 알려 준다.
pub async fn save_one(
    store: &Store,
    provider: &dyn MailProvider,
    mail_id: &str,
    attachment_id: i64,
    choose: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<(SaveOutcome, Option<PathBuf>), AttachmentError> {
    let att = store
        .attachment_ref(mail_id, attachment_id)?
        .ok_or(AttachmentError::NotFound)?;
    let Some(path) = choose(&sanitize_file_name(&att.target.name)) else {
        return Ok((SaveOutcome::Cancelled, None));
    };
    let data = download(provider, &att).await?;
    write_blocking(path.clone(), data.data).await?;
    Ok((SaveOutcome::Saved { count: 1 }, Some(path)))
}

/// 메일의 첨부 전체를 `choose_dir`가 고른 폴더에 저장한다. 이름이 겹치면 번호를 붙인다.
/// 메일은 한 번만 받는다. 저장한 첫 파일의 경로를 함께 돌려준다.
pub async fn save_all(
    store: &Store,
    provider: &dyn MailProvider,
    mail_id: &str,
    choose_dir: impl FnOnce() -> Option<PathBuf>,
) -> Result<(SaveOutcome, Option<PathBuf>), AttachmentError> {
    let atts = store.attachment_refs(mail_id)?;
    let Some(first) = atts.first() else {
        return Err(AttachmentError::NotFound);
    };
    let Some(dir) = choose_dir() else {
        return Ok((SaveOutcome::Cancelled, None));
    };
    let targets: Vec<_> = atts.iter().map(|a| a.target.clone()).collect();
    let all = provider
        .fetch_attachments(&first.mail.folder_key, &first.mail.remote_id, &targets)
        .await?;
    let mut first_path = None;
    for data in &all {
        let path = unique_path(&dir, &sanitize_file_name(&data.name));
        write_blocking(path.clone(), data.data.clone()).await?;
        first_path.get_or_insert(path);
    }
    Ok((SaveOutcome::Saved { count: all.len() }, first_path))
}

async fn download(
    provider: &dyn MailProvider,
    att: &AttachmentRef,
) -> Result<AttachmentData, AttachmentError> {
    Ok(provider
        .fetch_attachment(&att.mail.folder_key, &att.mail.remote_id, &att.target)
        .await?)
}

#[cfg(test)]
mod tests;
