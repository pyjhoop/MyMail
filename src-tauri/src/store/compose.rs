//! 작성 중인 메일(임시보관)과 보내지 못한 메일, 주소 자동완성, 서명.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{make_preview, LabelTag, MailSummary, Store, StoreError};

/// 보내지 못한 메일을 목록에서 구분하는 라벨 (계정 색 8번 = 빨강 계열)
const FAILED_LABEL: &str = "보내지 못함";
const FAILED_LABEL_COLOR: u8 = 8;
/// 자동완성에 보여줄 최대 개수
const SUGGEST_LIMIT: usize = 6;
/// 보낸 메일 받는 사람을 훑는 최대 메일 수
const SENT_SCAN_LIMIT: i64 = 500;

/// UI가 저장하는 작성 내용. 첨부는 따로 올린다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeInput {
    pub id: String,
    pub account_id: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeAttachment {
    pub id: i64,
    pub name: String,
    /// 바이트
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeMail {
    pub id: String,
    pub account_id: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    /// `draft` | `failed`
    pub status: String,
    /// 보내기에 실패했을 때의 안내
    pub error: Option<String>,
    pub attachments: Vec<ComposeAttachment>,
}

/// 발송할 때 읽는 첨부 내용
#[derive(Debug, Clone)]
pub struct ComposeAttachmentData {
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AddressSuggestion {
    pub name: String,
    pub email: String,
}

fn to_json(list: &[String]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".into())
}

fn from_json(text: &str) -> Vec<String> {
    serde_json::from_str(text).unwrap_or_default()
}

/// `이름 <주소>` 또는 `주소`에서 (이름, 주소)를 뽑는다.
pub fn split_address(raw: &str) -> (String, String) {
    let raw = raw.trim();
    match (raw.rfind('<'), raw.rfind('>')) {
        (Some(open), Some(close)) if open < close => (
            raw[..open].trim().trim_matches('"').trim().to_string(),
            raw[open + 1..close].trim().to_string(),
        ),
        _ => (String::new(), raw.to_string()),
    }
}

/// 임시보관함 목록에 끼워 넣을 요약. 시간순 정렬은 호출한 쪽이 한다.
pub(super) fn summaries(
    conn: &Connection,
    account_id: &str,
    folder_id: &str,
) -> Result<Vec<MailSummary>, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.to_addrs, c.subject, c.body, c.status, c.updated_at,
                EXISTS(SELECT 1 FROM compose_attachments a WHERE a.mail_id = c.id)
         FROM compose_mails c WHERE c.account_id = ?1",
    )?;
    let rows = stmt.query_map([account_id], |r| {
        let to = from_json(&r.get::<_, String>(1)?);
        let first = to.first().map(|t| split_address(t));
        let subject: String = r.get(2)?;
        let failed = r.get::<_, String>(4)? == "failed";
        Ok(MailSummary {
            id: r.get(0)?,
            account_id: account_id.to_string(),
            folder_id: folder_id.to_string(),
            sender: match &first {
                Some((name, email)) if !name.is_empty() => name.clone(),
                Some((_, email)) => email.clone(),
                None => "(받는사람 없음)".into(),
            },
            sender_email: first.map(|(_, email)| email).unwrap_or_default(),
            subject: if subject.trim().is_empty() {
                "(제목 없음)".into()
            } else {
                subject
            },
            preview: make_preview(&r.get::<_, String>(3)?),
            received_at: r.get(5)?,
            unread: false,
            starred: false,
            has_attachment: r.get(6)?,
            thread_count: None,
            label: failed.then(|| LabelTag {
                name: FAILED_LABEL.into(),
                color_index: FAILED_LABEL_COLOR,
            }),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// LIKE 패턴의 특수 문자를 이스케이프한다 (`ESCAPE '\'`와 함께 쓴다).
fn like_pattern(query: &str) -> String {
    let escaped: String = query
        .chars()
        .flat_map(|c| match c {
            '%' | '_' | '\\' => vec!['\\', c],
            other => vec![other],
        })
        .collect();
    format!("%{escaped}%")
}

impl Store {
    /// 작성 내용을 저장한다. 같은 id가 있으면 덮어쓰며, 보내기에 실패했던 메일도 다시 임시 상태가 된다.
    pub fn save_compose(&self, input: &ComposeInput) -> Result<(), StoreError> {
        self.lock()?.execute(
            "INSERT INTO compose_mails (id, account_id, to_addrs, cc_addrs, bcc_addrs, subject, body,
                 status, error, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', NULL, CAST(strftime('%s', 'now') AS INTEGER))
             ON CONFLICT(id) DO UPDATE SET account_id = ?2, to_addrs = ?3, cc_addrs = ?4,
                 bcc_addrs = ?5, subject = ?6, body = ?7, status = 'draft', error = NULL,
                 updated_at = CAST(strftime('%s', 'now') AS INTEGER)",
            params![
                input.id,
                input.account_id,
                to_json(&input.to),
                to_json(&input.cc),
                to_json(&input.bcc),
                input.subject,
                input.body,
            ],
        )?;
        Ok(())
    }

    pub fn get_compose(&self, id: &str) -> Result<Option<ComposeMail>, StoreError> {
        let conn = self.lock()?;
        let head = conn
            .query_row(
                "SELECT account_id, to_addrs, cc_addrs, bcc_addrs, subject, body, status, error
                 FROM compose_mails WHERE id = ?1",
                [id],
                |r| {
                    Ok(ComposeMail {
                        id: id.to_string(),
                        account_id: r.get(0)?,
                        to: from_json(&r.get::<_, String>(1)?),
                        cc: from_json(&r.get::<_, String>(2)?),
                        bcc: from_json(&r.get::<_, String>(3)?),
                        subject: r.get(4)?,
                        body: r.get(5)?,
                        status: r.get(6)?,
                        error: r.get(7)?,
                        attachments: Vec::new(),
                    })
                },
            )
            .optional()?;
        let Some(mut mail) = head else {
            return Ok(None);
        };
        mail.attachments = conn
            .prepare(
                "SELECT id, name, length(data) FROM compose_attachments
                 WHERE mail_id = ?1 ORDER BY id",
            )?
            .query_map([id], |r| {
                Ok(ComposeAttachment {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    size: r.get::<_, i64>(2)?.max(0) as u64,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(Some(mail))
    }

    /// 첨부까지 함께 지운다(ON DELETE CASCADE).
    pub fn delete_compose(&self, id: &str) -> Result<(), StoreError> {
        self.lock()?
            .execute("DELETE FROM compose_mails WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn set_compose_failed(&self, id: &str, error: &str) -> Result<(), StoreError> {
        self.lock()?.execute(
            "UPDATE compose_mails SET status = 'failed', error = ?2 WHERE id = ?1",
            params![id, error],
        )?;
        Ok(())
    }

    pub fn add_compose_attachment(
        &self,
        mail_id: &str,
        name: &str,
        mime: &str,
        data: &[u8],
    ) -> Result<i64, StoreError> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO compose_attachments (mail_id, name, mime, data) VALUES (?1, ?2, ?3, ?4)",
            params![mail_id, name, mime, data],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn remove_compose_attachment(&self, mail_id: &str, id: i64) -> Result<(), StoreError> {
        self.lock()?.execute(
            "DELETE FROM compose_attachments WHERE id = ?1 AND mail_id = ?2",
            params![id, mail_id],
        )?;
        Ok(())
    }

    /// 메일에 붙은 첨부의 총 바이트
    pub fn compose_attachment_bytes(&self, mail_id: &str) -> Result<u64, StoreError> {
        let total: i64 = self.lock()?.query_row(
            "SELECT COALESCE(SUM(length(data)), 0) FROM compose_attachments WHERE mail_id = ?1",
            [mail_id],
            |r| r.get(0),
        )?;
        Ok(total.max(0) as u64)
    }

    pub fn compose_attachment_data(
        &self,
        mail_id: &str,
    ) -> Result<Vec<ComposeAttachmentData>, StoreError> {
        let conn = self.lock()?;
        let rows = conn
            .prepare(
                "SELECT name, mime, data FROM compose_attachments WHERE mail_id = ?1 ORDER BY id",
            )?
            .query_map([mail_id], |r| {
                Ok(ComposeAttachmentData {
                    name: r.get(0)?,
                    mime: r.get(1)?,
                    data: r.get(2)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn set_signature(&self, account_id: &str, signature: &str) -> Result<(), StoreError> {
        self.lock()?.execute(
            "UPDATE accounts SET signature = ?2 WHERE id = ?1",
            params![account_id, signature],
        )?;
        Ok(())
    }

    /// 계정의 표시 이름·주소·서비스 이름
    pub fn account_identity(
        &self,
        account_id: &str,
    ) -> Result<Option<(String, String, String)>, StoreError> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT name, email, provider FROM accounts WHERE id = ?1",
                [account_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?)
    }

    /// 받은 메일의 보낸 사람과 보낸 메일의 받는 사람 중 `query`와 맞는 주소를 자주 오간 순으로 돌려준다.
    /// 내 계정 주소는 뺀다.
    pub fn suggest_addresses(&self, query: &str) -> Result<Vec<AddressSuggestion>, StoreError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let pattern = like_pattern(query);
        let conn = self.lock()?;
        let own: Vec<String> = conn
            .prepare("SELECT lower(email) FROM accounts")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;

        // 주소 → (이름, 횟수)
        let mut found: HashMap<String, (String, u32)> = HashMap::new();
        let mut received = conn.prepare(
            "SELECT m.sender_email, m.sender, COUNT(*)
             FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE f.kind NOT IN ('sent', 'drafts', 'spam', 'trash') AND m.sender_email != ''
               AND (m.sender_email LIKE ?1 ESCAPE '\\' OR m.sender LIKE ?1 ESCAPE '\\')
             GROUP BY m.sender_email ORDER BY COUNT(*) DESC LIMIT 20",
        )?;
        for row in received.query_map([&pattern], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u32>(2)?,
            ))
        })? {
            let (email, name, count) = row?;
            let name = if name == email { String::new() } else { name };
            found.insert(email.to_lowercase(), (name, count));
        }

        // 보낸 메일의 받는 사람은 주소만 저장돼 있다. 내가 직접 보낸 상대이므로 가중치를 더한다.
        let mut sent = conn.prepare(
            "SELECT m.recipients FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE f.kind = 'sent' AND m.recipients LIKE ?1 ESCAPE '\\'
             ORDER BY m.received_at DESC LIMIT ?2",
        )?;
        let needle = query.to_lowercase();
        for row in sent.query_map(params![pattern, SENT_SCAN_LIMIT], |r| r.get::<_, String>(0))? {
            for email in row?.split(',').map(|e| e.trim().to_lowercase()) {
                if email.contains(&needle) {
                    found.entry(email).or_default().1 += 3;
                }
            }
        }

        let mut list: Vec<(String, String, u32)> = found
            .into_iter()
            .filter(|(email, _)| !email.is_empty() && !own.contains(email))
            .map(|(email, (name, count))| (email, name, count))
            .collect();
        list.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
        list.truncate(SUGGEST_LIMIT);
        Ok(list
            .into_iter()
            .map(|(email, name, _)| AddressSuggestion { name, email })
            .collect())
    }
}
