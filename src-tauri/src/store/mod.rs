//! SQLite 저장소와 마이그레이션.

mod models;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};

use crate::providers::{RemoteFolder, RemoteMessage};
pub use models::{
    Account, Attachment, EarlierMail, Folder, LabelTag, MailDetail, MailSummary, NewAccount,
};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("데이터베이스 오류: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("데이터베이스 잠금 오류")]
    Poisoned,
}

/// 순서대로 적용한다. 스키마 변경은 여기에 파일을 추가하는 방식으로만 한다.
const MIGRATIONS: &[&str] = &[include_str!("migrations/0001_init.sql")];

const PREVIEW_CHARS: usize = 80;

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Self::from_connection(Connection::open(path)?)
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
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.conn.lock().map_err(|_| StoreError::Poisoned)
    }

    pub fn account_count(&self) -> Result<i64, StoreError> {
        Ok(self
            .lock()?
            .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))?)
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
                     has_attachment, label_name, label_color)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                 ON CONFLICT(id) DO UPDATE SET unread = ?12, starred = ?13,
                     label_name = ?15, label_color = ?16",
            )?;
            let mut delete_attachments =
                tx.prepare_cached("DELETE FROM attachments WHERE message_id = ?1")?;
            let mut insert_attachment = tx.prepare_cached(
                "INSERT INTO attachments (message_id, name, size, ext) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for m in messages {
                let id = format!("{folder}-{}", m.remote_id);
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
                ])?;
                delete_attachments.execute([&id])?;
                for a in &m.attachments {
                    insert_attachment.execute(params![
                        id,
                        a.name,
                        a.size as i64,
                        extension(&a.name)
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
            "SELECT a.id, a.name, a.email, a.provider, a.color_index, a.initial,
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
                unread: r.get(6)?,
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
    pub fn list_mails(
        &self,
        account_id: Option<&str>,
        folder_id: &str,
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
             WHERE {filter} ORDER BY m.received_at DESC, m.id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args), summary_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
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
                        m.recipients, m.body, m.thread_id
                 FROM messages m WHERE m.id = ?1",
                [id],
                |r| Ok((summary_from_row(r)?, r.get::<_, String>(14)?, r.get::<_, String>(15)?, r.get::<_, Option<String>>(16)?)),
            )
            .optional()?;
        let Some((summary, to, body, thread_id)) = head else {
            return Ok(None);
        };

        let attachments = conn
            .prepare("SELECT name, size, ext FROM attachments WHERE message_id = ?1 ORDER BY id")?
            .query_map([id], |r| {
                Ok(Attachment {
                    name: r.get(0)?,
                    size: r.get::<_, i64>(1)?.max(0) as u64,
                    ext: r.get(2)?,
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
            attachments,
            earlier,
        }))
    }

    #[allow(dead_code)] // M7에서 UI에 연결
    /// 계정 안에서 제목·보낸사람·본문을 FTS5로 검색한다 (M7에서 UI에 연결).
    pub fn search_mails(
        &self,
        account_id: &str,
        query: &str,
    ) -> Result<Vec<MailSummary>, StoreError> {
        let Some(fts) = fts_query(query) else {
            return Ok(Vec::new());
        };
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT m.id, m.account_id, m.folder_id, m.sender, m.sender_email, m.subject, m.preview,
                    m.received_at, m.unread, m.starred, m.has_attachment, m.label_name, m.label_color,
                    CASE WHEN m.thread_id IS NULL THEN 0
                         ELSE (SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.thread_id) END
             FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
             WHERE messages_fts MATCH ?1 AND m.account_id = ?2
             ORDER BY m.received_at DESC, m.id",
        )?;
        let rows = stmt.query_map(params![fts, account_id], summary_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
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

fn make_preview(body: &str) -> String {
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(PREVIEW_CHARS).collect()
}

fn extension(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_uppercase())
        .unwrap_or_default()
}

/// 사용자 입력을 FTS5 접두 검색식으로 바꾼다. 따옴표로 감싸 연산자 해석을 막는다.
#[allow(dead_code)] // M7에서 UI에 연결
fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .filter(|t| t != "\"\"*")
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

#[cfg(test)]
mod tests;
