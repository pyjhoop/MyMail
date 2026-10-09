//! `MailProvider` trait과 구현체(imap 공통, gmail·naver, fake).
//! 서비스별 차이는 구현체 안에서만 처리하고, 상위 계층은 이 trait만 안다.

#[cfg(test)]
pub mod fake;
pub mod gmail;
pub mod imap;
pub mod naver;

use std::time::Duration;

use async_trait::async_trait;

#[allow(dead_code)] // NotFound는 테스트용 FakeProvider만 사용
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("네트워크 오류: {0}")]
    Network(String),
    #[error("인증 실패: {0}")]
    Auth(String),
    #[error("찾을 수 없음: {0}")]
    NotFound(String),
    #[error("지원하지 않는 서비스: {0}")]
    Unsupported(String),
    /// 서버가 요청을 거절했다(없는 메일·폴더 등). 같은 요청을 다시 보내도 소용없다.
    #[error("서버가 거절했어요: {0}")]
    Rejected(String),
}

#[allow(dead_code)] // Label은 아직 만드는 곳이 없음
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderKind {
    Inbox,
    Sent,
    Drafts,
    Spam,
    Trash,
    /// 전체보관함(Gmail `\All`). 다른 폴더 메일이 모두 들어 있어 가장 마지막에 동기화한다.
    All,
    Label,
    Folder,
}

impl FolderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Sent => "sent",
            Self::Drafts => "drafts",
            Self::Spam => "spam",
            Self::Trash => "trash",
            // UI에서는 일반 폴더로 보인다. 구분은 동기화 순서에만 쓴다.
            Self::All => "folder",
            Self::Label => "label",
            Self::Folder => "folder",
        }
    }
}

/// 서버의 폴더(라벨). `key`는 계정 안에서 유일한 안정적 식별자다.
#[derive(Debug, Clone)]
pub struct RemoteFolder {
    pub key: String,
    pub name: String,
    pub kind: FolderKind,
    pub color_index: Option<u8>,
    pub depth: u8,
    pub expandable: bool,
}

#[derive(Debug, Clone)]
pub struct RemoteAttachment {
    pub name: String,
    pub size: u64,
    /// 메일 원문에서 첨부를 센 순서(0부터). 내려받을 때 어느 파트인지 가리킨다.
    pub part_index: u32,
    pub mime: String,
}

/// 내려받을 첨부를 가리키는 값. 저장해 둔 `part_index`가 없는 옛 메일은 이름·크기로 찾는다.
#[derive(Debug, Clone)]
pub struct AttachmentTarget {
    pub part_index: Option<u32>,
    pub name: String,
    pub size: u64,
}

/// 내려받은 첨부 내용
#[derive(Debug, Clone)]
pub struct AttachmentData {
    pub name: String,
    #[allow(dead_code)] // 이미지·PDF 미리보기(후속)에서 쓴다
    pub mime: String,
    pub data: Vec<u8>,
}

/// HTML 본문이 `cid:`로 가리키는 인라인 이미지. 첨부 목록에는 올리지 않는다.
#[derive(Debug, Clone)]
pub struct RemoteInlineImage {
    /// 꺾쇠를 뗀 Content-ID
    pub content_id: String,
    pub mime: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct RemoteMessage {
    /// 폴더 안에서 유일한 서버 식별자 (IMAP UID 등)
    pub remote_id: String,
    pub thread_id: Option<String>,
    /// 폴더가 달라도 같은 메일이면 같은 값 (Gmail X-GM-MSGID). 계정 안에서 한 번만 저장한다.
    pub dedupe_key: Option<String>,
    pub sender: String,
    pub sender_email: String,
    pub recipients: String,
    pub subject: String,
    /// 미리보기·검색용 텍스트. HTML만 있는 메일은 태그·주석·스타일을 걷어낸 결과다.
    pub body: String,
    /// 정제 전 원문 HTML. 표시할 때 UI가 DOMPurify로 정제한다.
    pub html: Option<String>,
    /// 유닉스 시간(초)
    pub received_at: i64,
    pub unread: bool,
    pub starred: bool,
    pub label: Option<(String, u8)>,
    pub attachments: Vec<RemoteAttachment>,
    pub inline_images: Vec<RemoteInlineImage>,
}

/// 서버에 있는 메일 한 통의 상태. 본문 없이 UID와 플래그만 담아 가볍게 대조하는 데 쓴다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFlags {
    pub remote_id: String,
    pub unread: bool,
    pub starred: bool,
}

/// 폴더 전체의 UID·플래그 목록과 UID가 유효한지 판단하는 값.
#[derive(Debug, Clone, Default)]
pub struct FolderSnapshot {
    /// IMAP UIDVALIDITY. 이전과 다르면 저장해 둔 UID는 모두 무효다. 모르면 `None`.
    pub uid_validity: Option<u32>,
    pub messages: Vec<RemoteFlags>,
}

#[derive(Debug, Clone)]
pub struct OutgoingAttachment {
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
}

/// 보낼 메일. 주소는 `이름 <주소>` 또는 `주소` 꼴이다.
#[derive(Debug, Clone)]
pub struct OutgoingMail {
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    /// 일반 텍스트 본문
    pub body: String,
    pub attachments: Vec<OutgoingAttachment>,
}

fn unsupported<T>(what: &str) -> Result<T, ProviderError> {
    Err(ProviderError::Unsupported(what.into()))
}

#[async_trait]
pub trait MailProvider: Send + Sync {
    /// 접속과 로그인이 되는지만 확인한다. 계정 추가 전에 자격 증명을 검증할 때 쓴다.
    async fn verify(&self) -> Result<(), ProviderError>;

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, ProviderError>;

    /// 폴더의 메일을 최신순으로 최대 `limit`건 가져온다.
    async fn fetch_messages(
        &self,
        folder_key: &str,
        limit: usize,
    ) -> Result<Vec<RemoteMessage>, ProviderError>;

    /// 폴더에 있는 모든 메일의 UID와 플래그. 본문은 받지 않는다.
    async fn snapshot(&self, _folder_key: &str) -> Result<FolderSnapshot, ProviderError> {
        unsupported("폴더 상태 조회")
    }

    /// 지정한 서버 식별자의 메일을 받는다. 서버에서 사라진 것은 결과에서 빠진다.
    async fn fetch_by_ids(
        &self,
        _folder_key: &str,
        _ids: &[String],
    ) -> Result<Vec<RemoteMessage>, ProviderError> {
        unsupported("메일 받기")
    }

    async fn set_seen(
        &self,
        _folder_key: &str,
        _remote_id: &str,
        _seen: bool,
    ) -> Result<(), ProviderError> {
        unsupported("읽음 표시")
    }

    async fn set_flagged(
        &self,
        _folder_key: &str,
        _remote_id: &str,
        _flagged: bool,
    ) -> Result<(), ProviderError> {
        unsupported("별표")
    }

    async fn move_message(
        &self,
        _folder_key: &str,
        _remote_id: &str,
        _dest_key: &str,
    ) -> Result<(), ProviderError> {
        unsupported("메일 이동")
    }

    /// 서버에서 메일을 완전히 지운다. 휴지통으로 보내려면 `move_message`를 쓴다.
    async fn delete_message(
        &self,
        _folder_key: &str,
        _remote_id: &str,
    ) -> Result<(), ProviderError> {
        unsupported("메일 삭제")
    }

    /// 첨부 하나의 내용을 받는다. `\Seen`이 달리지 않아야 한다(읽음 상태를 바꾸지 않는다).
    async fn fetch_attachment(
        &self,
        _folder_key: &str,
        _remote_id: &str,
        _target: &AttachmentTarget,
    ) -> Result<AttachmentData, ProviderError> {
        unsupported("첨부 받기")
    }

    /// 같은 메일의 첨부 여러 개를 받는다. 구현체가 메일을 한 번만 받도록 오버라이드할 수 있다.
    async fn fetch_attachments(
        &self,
        folder_key: &str,
        remote_id: &str,
        targets: &[AttachmentTarget],
    ) -> Result<Vec<AttachmentData>, ProviderError> {
        let mut out = Vec::with_capacity(targets.len());
        for t in targets {
            out.push(self.fetch_attachment(folder_key, remote_id, t).await?);
        }
        Ok(out)
    }

    /// 메일을 보낸다(SMTP). 서버가 보낸편지함에 사본을 남기는지는 서비스에 따른다.
    async fn send(&self, _mail: &OutgoingMail) -> Result<(), ProviderError> {
        unsupported("메일 보내기")
    }

    /// 폴더에 변화가 생기거나 `timeout`이 지날 때까지 기다린다(IMAP IDLE).
    /// 서버가 푸시를 지원하지 않으면 `Unsupported`를 돌려주고, 호출한 쪽이 주기적으로 조회한다.
    async fn wait_for_changes(
        &self,
        _folder_key: &str,
        _timeout: Duration,
    ) -> Result<(), ProviderError> {
        unsupported("새 메일 알림")
    }
}

/// 서비스가 받아주는 메일 한 통의 최대 크기(바이트). 모르는 서비스면 `None`.
pub fn message_size_limit(provider: &str) -> Option<u64> {
    match provider {
        "naver" => Some(naver::CONFIG.max_message_bytes),
        "gmail" => Some(gmail::CONFIG.max_message_bytes),
        _ => None,
    }
}

/// 서비스 이름으로 구현체를 고른다. 서비스별 분기는 여기까지만 허용한다.
pub fn create(
    provider: &str,
    email: &str,
    password: &str,
) -> Result<Box<dyn MailProvider>, ProviderError> {
    match provider {
        "naver" => Ok(Box::new(imap::ImapProvider::new(
            naver::CONFIG,
            email.into(),
            password.into(),
        ))),
        "gmail" => Ok(Box::new(imap::ImapProvider::new(
            gmail::CONFIG,
            email.into(),
            password.into(),
        ))),
        other => Err(ProviderError::Unsupported(other.into())),
    }
}
