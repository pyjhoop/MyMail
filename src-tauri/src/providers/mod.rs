//! `MailProvider` trait과 구현체(imap 공통, gmail·naver, fake).
//! 서비스별 차이는 구현체 안에서만 처리하고, 상위 계층은 이 trait만 안다.

#[cfg(test)]
pub mod fake;
pub mod imap;
pub mod naver;

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
}

#[allow(dead_code)] // Label은 M4(Gmail)에서 사용
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderKind {
    Inbox,
    Sent,
    Drafts,
    Spam,
    Trash,
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
}

#[derive(Debug, Clone)]
pub struct RemoteMessage {
    /// 폴더 안에서 유일한 서버 식별자 (IMAP UID 등)
    pub remote_id: String,
    pub thread_id: Option<String>,
    pub sender: String,
    pub sender_email: String,
    pub recipients: String,
    pub subject: String,
    pub body: String,
    /// 유닉스 시간(초)
    pub received_at: i64,
    pub unread: bool,
    pub starred: bool,
    pub label: Option<(String, u8)>,
    pub attachments: Vec<RemoteAttachment>,
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
        other => Err(ProviderError::Unsupported(other.into())),
    }
}
