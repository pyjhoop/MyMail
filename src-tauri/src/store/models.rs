//! UI로 그대로 직렬화되는 데이터 모양. 필드 이름은 `src/lib/ipc.ts`와 맞춘다.

use serde::Serialize;

pub struct NewAccount {
    pub id: String,
    pub name: String,
    pub email: String,
    pub provider: String,
    pub color_index: u8,
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
    pub label: Option<LabelTag>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
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
