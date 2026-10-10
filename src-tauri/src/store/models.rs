//! UI로 그대로 직렬화되는 데이터 모양. 필드 이름은 `src/lib/ipc.ts`와 맞춘다.

use serde::Serialize;

pub struct NewAccount {
    pub id: String,
    pub name: String,
    pub email: String,
    pub provider: String,
    pub color_index: u8,
}

/// 폴더 목록 한 페이지. 마지막 페이지면 `next_cursor`가 없다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailPage {
    pub mails: Vec<MailSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub email: String,
    pub provider: String,
    pub color_index: u8,
    pub unread: u32,
    pub initial: String,
    /// 새 메일·답장 끝에 넣는 서명(일반 텍스트). 없으면 빈 문자열
    pub signature: String,
    /// 답장·전달에도 서명을 넣을지
    pub sign_replies: bool,
    /// 새 메일 알림 켜기
    pub notify_enabled: bool,
    /// 알림 대상: `inbox` | `all` | `starred`
    pub notify_scope: String,
    pub notify_sound: bool,
    /// 작업 표시줄·트레이에 안 읽은 수 표시
    pub notify_badge: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub kind: String,
    pub unread: u32,
    pub color_index: Option<u8>,
    pub depth: u8,
    pub expandable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelTag {
    pub name: String,
    pub color_index: u8,
}

impl LabelTag {
    pub fn new(name: String) -> Self {
        let color_index = label_color(&name);
        Self { name, color_index }
    }
}

/// 라벨 이름으로 정하는 색(1~8). 같은 이름이면 언제나 같은 색이다.
/// UI의 `labelColor`(src/lib/labels.ts)와 같은 계산이어야 폴더 패널의 색과 맞는다.
pub fn label_color(name: &str) -> u8 {
    let hash = name
        .bytes()
        .fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(u32::from(b)));
    (hash % 8) as u8 + 1
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSummary {
    pub id: String,
    pub account_id: String,
    pub folder_id: String,
    pub sender: String,
    pub sender_email: String,
    pub subject: String,
    pub preview: String,
    /// 유닉스 시간(초). 표시용 문구는 UI가 만든다.
    pub received_at: i64,
    pub unread: bool,
    pub starred: bool,
    pub has_attachment: bool,
    pub thread_count: Option<u32>,
    /// 붙은 라벨 전체(시스템 라벨 제외). 없으면 빈 목록
    pub labels: Vec<LabelTag>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    /// 내려받을 때 가리키는 번호. 이름이 같은 첨부도 구분한다.
    pub id: i64,
    pub name: String,
    /// 바이트
    pub size: u64,
    pub ext: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarlierMail {
    pub sender: String,
    pub initial: String,
    pub preview: String,
    pub received_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDetail {
    #[serde(flatten)]
    pub summary: MailSummary,
    pub to: String,
    /// 문단 배열
    pub body: Vec<String>,
    /// 정제 전 원문 HTML(`cid:` 이미지는 `data:` URI로 바꿈). 없으면 텍스트 메일이다.
    pub html: Option<String>,
    pub attachments: Vec<Attachment>,
    pub earlier: Vec<EarlierMail>,
}

/// 메일 목록 정렬. UI가 보내는 문자열은 `parse`로만 받아들이고, SQL에는 고정된 `ORDER BY` 문구만 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MailSort {
    #[default]
    Newest,
    Oldest,
    Sender,
    Subject,
    Unread,
}

impl MailSort {
    /// 허용된 값만 받는다. 그 밖의 문자열은 `None`.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "newest" => Self::Newest,
            "oldest" => Self::Oldest,
            "sender" => Self::Sender,
            "subject" => Self::Subject,
            "unread" => Self::Unread,
            _ => return None,
        })
    }

    /// `messages`를 `m`으로 부른 쿼리에 붙이는 `ORDER BY` 식. 같은 값끼리는 `m.id`로 순서를 고정한다.
    pub(super) fn order_by(self) -> &'static str {
        match self {
            Self::Newest => "m.received_at DESC, m.id",
            Self::Oldest => "m.received_at ASC, m.id",
            Self::Sender => "m.sender COLLATE NOCASE ASC, m.received_at DESC, m.id",
            Self::Subject => "m.subject COLLATE NOCASE ASC, m.received_at DESC, m.id",
            Self::Unread => "m.unread DESC, m.received_at DESC, m.id",
        }
    }

    /// 작성 중 메일을 섞은 목록을 `order_by`와 같은 기준으로 다시 정렬한다.
    pub(super) fn sort(self, mails: &mut [MailSummary]) {
        use std::cmp::Reverse;
        match self {
            Self::Newest => mails.sort_by_cached_key(|m| (Reverse(m.received_at), m.id.clone())),
            Self::Oldest => mails.sort_by_cached_key(|m| (m.received_at, m.id.clone())),
            Self::Sender => mails.sort_by_cached_key(|m| {
                (
                    m.sender.to_lowercase(),
                    Reverse(m.received_at),
                    m.id.clone(),
                )
            }),
            Self::Subject => mails.sort_by_cached_key(|m| {
                (
                    m.subject.to_lowercase(),
                    Reverse(m.received_at),
                    m.id.clone(),
                )
            }),
            Self::Unread => mails
                .sort_by_cached_key(|m| (Reverse(m.unread), Reverse(m.received_at), m.id.clone())),
        }
    }
}
