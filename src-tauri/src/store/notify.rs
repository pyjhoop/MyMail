//! 새 메일 알림에 쓰는 조회: 동기화 전후로 새로 들어온 안 읽은 받은편지함 메일을 찾는다.

use rusqlite::params;

use super::{Store, StoreError};

/// 알림에 보여 줄 새 메일
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMail {
    pub sender: String,
    pub subject: String,
}

impl Store {
    /// 계정의 가장 최근에 저장된 메일 위치. 동기화 전에 기록해 두고, 이후 `new_unread_inbox`에 넘긴다.
    pub fn mail_watermark(&self, account_id: &str) -> Result<i64, StoreError> {
        let conn = self.lock()?;
        Ok(conn.query_row(
            "SELECT COALESCE(MAX(rowid), 0) FROM messages WHERE account_id = ?1",
            [account_id],
            |r| r.get(0),
        )?)
    }

    /// `watermark` 이후 저장된 안 읽은 받은편지함 메일, 오래된 것부터.
    pub fn new_unread_inbox(
        &self,
        account_id: &str,
        watermark: i64,
    ) -> Result<Vec<NewMail>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT m.sender, m.subject FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE m.account_id = ?1 AND m.rowid > ?2 AND m.unread = 1 AND f.kind = 'inbox'
             ORDER BY m.rowid",
        )?;
        let rows = stmt.query_map(params![account_id, watermark], |r| {
            Ok(NewMail {
                sender: r.get(0)?,
                subject: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}
