//! SQLite 저장소와 마이그레이션.

mod attachments;
mod compose;
mod models;
mod notify;
pub mod search;
mod sync_state;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};

use crate::providers::{RemoteFolder, RemoteMessage};
pub use attachments::AttachmentRef;
pub use compose::{split_address, AddressSuggestion, ComposeInput, ComposeMail};
pub use models::{
    Account, Attachment, EarlierMail, Folder, LabelTag, MailDetail, MailSort, MailSummary,
    NewAccount,
};
pub use notify::NewMail;
pub use search::{ParsedQuery, SearchPage, SearchRequest, SenderSuggestion};
pub use sync_state::{folder_key, OpKind};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("데이터베이스 오류: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("데이터베이스 잠금 오류")]
    Poisoned,
}

/// 순서대로 적용한다. 스키마 변경은 여기에 파일을 추가하는 방식으로만 한다.
const MIGRATIONS: &[&str] = &[
    include_str!("migrations/0001_init.sql"),
    include_str!("migrations/0002_html_body.sql"),
    include_str!("migrations/0003_dedupe_key.sql"),
    include_str!("migrations/0004_sync.sql"),
    include_str!("migrations/0005_compose.sql"),
    include_str!("migrations/0006_compose_quote.sql"),
    include_str!("migrations/0007_attachment_part.sql"),
    include_str!("migrations/0008_search.sql"),
];

const PREVIEW_CHARS: usize = 80;

pub struct Store {
    conn: Mutex<Connection>,
    /// 읽기 전용 연결. WAL이라 동기화가 쓰는 동안에도 검색이 기다리지 않는다. 메모리 DB에서는 없다.
    reader: Option<Mutex<Connection>>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        // 새 DB만 페이지를 16KB로 만든다(만든 뒤에는 못 바꾼다). 본문이 2~3KB인 행이 4KB 페이지에는
        // 한 줄씩만 들어가 낭비가 크기 때문이다. 이미 있는 DB는 그대로 둔다.
        let fresh = std::fs::metadata(path).map_or(true, |m| m.len() == 0);
        let conn = Connection::open(path)?;
        if fresh {
            conn.pragma_update(None, "page_size", 16384)?;
        }
        // WAL: 읽기와 쓰기가 서로 막지 않는다. NORMAL은 WAL에서 쓰기가 빠르면서 안전하다.
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get::<_, String>(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut store = Self::from_connection(conn)?;
        let reader = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        reader.busy_timeout(std::time::Duration::from_secs(5))?;
        store.reader = Some(Mutex::new(reader));
        Ok(store)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(mut conn: Connection) -> Result<Self, StoreError> {
        conn.pragma_update(None, "foreign_keys", true)?;
        migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            reader: None,
        })
    }

    /// 읽기 전용 질의용. 읽기 연결이 없으면 쓰기 연결을 쓴다.
    fn read_lock(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        match &self.reader {
            Some(r) => r.lock().map_err(|_| StoreError::Poisoned),
            None => self.lock(),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.conn.lock().map_err(|_| StoreError::Poisoned)
    }

    pub fn account_count(&self) -> Result<i64, StoreError> {
        Ok(self
            .lock()?
            .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))?)
    }

    pub fn account_email_exists(&self, email: &str) -> Result<bool, StoreError> {
        Ok(self.lock()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE lower(email) = lower(?1))",
            [email],
            |r| r.get(0),
        )?)
    }

    /// 계정과 딸린 폴더·메일·첨부를 지운다(ON DELETE CASCADE).
    pub fn delete_account(&self, account_id: &str) -> Result<(), StoreError> {
        self.lock()?
            .execute("DELETE FROM accounts WHERE id = ?1", [account_id])?;
        Ok(())
    }

    pub fn insert_account(&self, account: &NewAccount) -> Result<(), StoreError> {
        let conn = self.lock()?;
        let position: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))?;
        conn.execute(
            "INSERT INTO accounts (id, name, email, provider, color_index, initial, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                account.id,
                account.name,
                account.email,
                account.provider,
                account.color_index,
                account
                    .name
                    .chars()
                    .next()
                    .map(String::from)
                    .unwrap_or_default(),
                position
            ],
        )?;
        Ok(())
    }

    /// 계정의 폴더를 서버 목록으로 교체한다. 폴더 id는 `{계정}-{key}`.
    pub fn save_folders(
        &self,
        account_id: &str,
        folders: &[RemoteFolder],
    ) -> Result<(), StoreError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        for (position, f) in folders.iter().enumerate() {
            tx.execute(
                "INSERT INTO folders (id, account_id, name, kind, color_index, depth, expandable, position)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET name = ?3, kind = ?4, color_index = ?5,
                     depth = ?6, expandable = ?7, position = ?8",
                params![
                    folder_id(account_id, &f.key),
                    account_id,
                    f.name,
                    f.kind.as_str(),
                    f.color_index,
                    f.depth,
                    f.expandable,
                    position as i64
                ],
            )?;
        }
        // 서버에서 사라진 폴더는 딸린 메일과 함께 지운다.
        let keep: std::collections::HashSet<String> = folders
            .iter()
            .map(|f| folder_id(account_id, &f.key))
            .collect();
        let existing: Vec<String> = tx
            .prepare("SELECT id FROM folders WHERE account_id = ?1")?
            .query_map([account_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        for id in existing.iter().filter(|id| !keep.contains(*id)) {
            tx.execute("DELETE FROM folders WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 폴더의 메일을 저장한다. 이미 있는 메일은 서버 값으로 갱신한다.
    pub fn save_messages(
        &self,
        account_id: &str,
        folder_key: &str,
        messages: &[RemoteMessage],
    ) -> Result<(), StoreError> {
        let folder = folder_id(account_id, folder_key);
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        {
            let mut insert = tx.prepare_cached(
                "INSERT INTO messages (id, account_id, folder_id, thread_id, sender, sender_email,
                     recipients, subject, preview, body, received_at, unread, starred,
                     has_attachment, label_name, label_color, html, dedupe_key)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
                 ON CONFLICT(id) DO UPDATE SET unread = ?12, starred = ?13,
                     label_name = ?15, label_color = ?16,
                     preview = ?9, body = ?10, html = ?17, has_attachment = ?14, dedupe_key = ?18",
            )?;
            let mut delete_inline =
                tx.prepare_cached("DELETE FROM inline_images WHERE message_id = ?1")?;
            let mut insert_inline = tx.prepare_cached(
                "INSERT OR REPLACE INTO inline_images (message_id, content_id, mime, data)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            let mut delete_attachments =
                tx.prepare_cached("DELETE FROM attachments WHERE message_id = ?1")?;
            let mut insert_attachment = tx.prepare_cached(
                "INSERT INTO attachments (message_id, name, size, ext, part_index, mime)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            let mut stored_elsewhere = tx.prepare_cached(
                "SELECT 1 FROM messages WHERE account_id = ?1 AND dedupe_key = ?2 AND id != ?3",
            )?;
            let mut record_uid = tx.prepare_cached(
                "INSERT OR REPLACE INTO folder_uids (folder_id, remote_id, dedupe_key)
                 VALUES (?1, ?2, ?3)",
            )?;
            for m in messages {
                let id = format!("{folder}-{}", m.remote_id);
                record_uid.execute(params![folder, m.remote_id, m.dedupe_key])?;
                // 다른 폴더에 이미 저장된 같은 메일이면 건너뛴다(먼저 저장된 폴더가 차지한다).
                if let Some(key) = &m.dedupe_key {
                    if stored_elsewhere.exists(params![account_id, key, id])? {
                        continue;
                    }
                }
                insert.execute(params![
                    id,
                    account_id,
                    folder,
                    m.thread_id.as_ref().map(|t| format!("{account_id}-{t}")),
                    m.sender,
                    m.sender_email,
                    m.recipients,
                    m.subject,
                    make_preview(&m.body),
                    m.body,
                    m.received_at,
                    m.unread,
                    m.starred,
                    !m.attachments.is_empty(),
                    m.label.as_ref().map(|l| l.0.as_str()),
                    m.label.as_ref().map(|l| l.1),
                    m.html,
                    m.dedupe_key,
                ])?;
                delete_inline.execute([&id])?;
                for img in &m.inline_images {
                    insert_inline.execute(params![id, img.content_id, img.mime, img.data])?;
                }
                delete_attachments.execute([&id])?;
                for a in &m.attachments {
                    insert_attachment.execute(params![
                        id,
                        a.name,
                        a.size as i64,
                        extension(&a.name),
                        a.part_index,
                        a.mime
                    ])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_accounts(&self) -> Result<Vec<Account>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT a.id, a.name, a.email, a.provider, a.color_index, a.initial, a.signature,
                    (SELECT COUNT(*) FROM messages m JOIN folders f ON f.id = m.folder_id
                      WHERE m.account_id = a.id AND f.kind = 'inbox' AND m.unread = 1)
             FROM accounts a ORDER BY a.position",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Account {
                id: r.get(0)?,
                name: r.get(1)?,
                email: r.get(2)?,
                provider: r.get(3)?,
                color_index: r.get(4)?,
                initial: r.get(5)?,
                signature: r.get(6)?,
                unread: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn list_folders(&self, account_id: &str) -> Result<Vec<Folder>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT f.id, f.account_id, f.name, f.kind, f.color_index, f.depth, f.expandable,
                    (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id AND m.unread = 1)
             FROM folders f WHERE f.account_id = ?1 ORDER BY f.position",
        )?;
        let rows = stmt.query_map([account_id], |r| {
            Ok(Folder {
                id: r.get(0)?,
                account_id: r.get(1)?,
                name: r.get(2)?,
                kind: r.get(3)?,
                color_index: r.get(4)?,
                depth: r.get(5)?,
                expandable: r.get(6)?,
                unread: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// `account_id`가 없으면 모든 계정의 받은편지함(통합 받은편지함)을 돌려준다.
    #[cfg(test)]
    pub fn list_mails(
        &self,
        account_id: Option<&str>,
        folder_id: &str,
    ) -> Result<Vec<MailSummary>, StoreError> {
        self.list_mails_sorted(account_id, folder_id, MailSort::default())
    }

    /// `list_mails`를 `sort` 순서로 돌려준다.
    pub fn list_mails_sorted(
        &self,
        account_id: Option<&str>,
        folder_id: &str,
        sort: MailSort,
    ) -> Result<Vec<MailSummary>, StoreError> {
        let conn = self.lock()?;
        let (filter, args): (&str, Vec<&str>) = match account_id {
            Some(_) => ("m.folder_id = ?1", vec![folder_id]),
            None => ("f.kind = 'inbox'", Vec::new()),
        };
        let sql = format!(
            "SELECT m.id, m.account_id, m.folder_id, m.sender, m.sender_email, m.subject, m.preview,
                    m.received_at, m.unread, m.starred, m.has_attachment, m.label_name, m.label_color,
                    CASE WHEN m.thread_id IS NULL THEN 0
                         ELSE (SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.thread_id) END
             FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE {filter} ORDER BY {order}",
            order = sort.order_by()
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args), summary_from_row)?;
        let mut mails: Vec<MailSummary> = rows.collect::<Result<_, _>>()?;
        drop(stmt);
        // 임시보관함에는 서버 메일 위에 이 앱에서 작성 중인 메일을 함께 보여준다.
        if let Some(account_id) = account_id {
            let is_drafts: bool = conn
                .query_row(
                    "SELECT kind = 'drafts' FROM folders WHERE id = ?1",
                    [folder_id],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(false);
            if is_drafts {
                mails.extend(compose::summaries(&conn, account_id, folder_id)?);
                sort.sort(&mut mails);
            }
        }
        Ok(mails)
    }

    pub fn get_mail(&self, id: &str) -> Result<Option<MailDetail>, StoreError> {
        let conn = self.lock()?;
        let head = conn
            .query_row(
                "SELECT m.id, m.account_id, m.folder_id, m.sender, m.sender_email, m.subject,
                        m.preview, m.received_at, m.unread, m.starred, m.has_attachment,
                        m.label_name, m.label_color,
                        CASE WHEN m.thread_id IS NULL THEN 0
                             ELSE (SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.thread_id) END,
                        m.recipients, m.body, m.thread_id, m.html
                 FROM messages m WHERE m.id = ?1",
                [id],
                |r| {
                    Ok((
                        summary_from_row(r)?,
                        r.get::<_, String>(14)?,
                        r.get::<_, String>(15)?,
                        r.get::<_, Option<String>>(16)?,
                        r.get::<_, Option<String>>(17)?,
                    ))
                },
            )
            .optional()?;
        let Some((summary, to, body, thread_id, html)) = head else {
            return Ok(None);
        };

        let html = match html {
            Some(html) => {
                let images: Vec<(String, String, Vec<u8>)> = conn
                    .prepare(
                        "SELECT content_id, mime, data FROM inline_images WHERE message_id = ?1",
                    )?
                    .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<Result<_, _>>()?;
                Some(inline_cid_images(html, &images))
            }
            None => None,
        };

        let attachments = conn
            .prepare(
                "SELECT id, name, size, ext FROM attachments WHERE message_id = ?1 ORDER BY id",
            )?
            .query_map([id], |r| {
                Ok(Attachment {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    size: r.get::<_, i64>(2)?.max(0) as u64,
                    ext: r.get(3)?,
                })
            })?
            .collect::<Result<_, _>>()?;

        let earlier = match thread_id {
            Some(t) => conn
                .prepare(
                    "SELECT sender, preview, received_at FROM messages
                     WHERE thread_id = ?1 AND id != ?2 AND received_at < ?3
                     ORDER BY received_at LIMIT 20",
                )?
                .query_map(params![t, id, summary.received_at], |r| {
                    let sender: String = r.get(0)?;
                    Ok(EarlierMail {
                        initial: sender.chars().next().map(String::from).unwrap_or_default(),
                        sender,
                        preview: r.get(1)?,
                        received_at: r.get(2)?,
                    })
                })?
                .collect::<Result<_, _>>()?,
            None => Vec::new(),
        };

        Ok(Some(MailDetail {
            summary,
            to,
            body: body.split("\n\n").map(str::to_owned).collect(),
            html,
            attachments,
            earlier,
        }))
    }
}

pub fn folder_id(account_id: &str, key: &str) -> String {
    format!("{account_id}-{key}")
}

fn migrate(conn: &mut Connection) -> Result<(), StoreError> {
    let applied: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(applied as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

fn summary_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MailSummary> {
    let label_name: Option<String> = r.get(11)?;
    let label_color: Option<u8> = r.get(12)?;
    let thread_count: u32 = r.get(13)?;
    Ok(MailSummary {
        id: r.get(0)?,
        account_id: r.get(1)?,
        folder_id: r.get(2)?,
        sender: r.get(3)?,
        sender_email: r.get(4)?,
        subject: r.get(5)?,
        preview: r.get(6)?,
        received_at: r.get(7)?,
        unread: r.get(8)?,
        starred: r.get(9)?,
        has_attachment: r.get(10)?,
        thread_count: (thread_count >= 2).then_some(thread_count),
        label: label_name
            .zip(label_color)
            .map(|(name, color_index)| LabelTag { name, color_index }),
    })
}

/// HTML의 `cid:` 참조를 저장해 둔 인라인 이미지의 `data:` URI로 바꾼다(대소문자 무시).
/// 저장되지 않은 `cid:`는 그대로 두며, UI의 정제·CSP 단계에서 어차피 로드되지 않는다.
fn inline_cid_images(mut html: String, images: &[(String, String, Vec<u8>)]) -> String {
    for (content_id, mime, data) in images {
        let needle = format!("cid:{}", content_id.to_ascii_lowercase());
        let uri = format!("data:{mime};base64,{}", BASE64.encode(data));
        // ASCII 소문자화는 바이트 위치를 바꾸지 않으므로 같은 인덱스로 원문을 자를 수 있다.
        let lower = html.to_ascii_lowercase();
        let mut out = String::with_capacity(html.len());
        let mut last = 0;
        for (at, _) in lower.match_indices(&needle) {
            out.push_str(&html[last..at]);
            out.push_str(&uri);
            last = at + needle.len();
        }
        out.push_str(&html[last..]);
        html = out;
    }
    html
}

fn make_preview(body: &str) -> String {
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(PREVIEW_CHARS).collect()
}

fn extension(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_uppercase())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
