//! 동기화 엔진이 쓰는 저장소 조작: 서버 UID 대조, 폴더 초기화, 오프라인 큐.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use super::{Store, StoreError};
use crate::providers::RemoteFlags;

/// 서버에 아직 보내지 못한 조작
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingOp {
    pub id: i64,
    pub kind: OpKind,
    pub folder_key: String,
    pub remote_id: String,
    pub arg: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    Seen,
    Flagged,
    Move,
    Delete,
    /// 폴더의 모든 메일을 완전히 지운다(휴지통·스팸함 비우기). `remote_id`는 비어 있다.
    EmptyFolder,
}

impl OpKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Seen => "seen",
            Self::Flagged => "flagged",
            Self::Move => "move",
            Self::Delete => "delete",
            Self::EmptyFolder => "empty_folder",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "seen" => Self::Seen,
            "flagged" => Self::Flagged,
            "move" => Self::Move,
            "delete" => Self::Delete,
            "empty_folder" => Self::EmptyFolder,
            _ => return None,
        })
    }
}

/// 로컬 메일이 서버의 어느 메일인지 가리킨다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailRef {
    pub account_id: String,
    pub folder_id: String,
    pub folder_kind: String,
    /// 계정 안에서 폴더를 가리키는 서버 key
    pub folder_key: String,
    pub remote_id: String,
}

impl Store {
    /// 폴더의 UIDVALIDITY. 아직 한 번도 동기화하지 않았으면 `None`.
    pub fn uid_validity(&self, folder_id: &str) -> Result<Option<u32>, StoreError> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT uid_validity FROM folders WHERE id = ?1",
                [folder_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten())
    }

    pub fn set_uid_validity(&self, folder_id: &str, value: Option<u32>) -> Result<(), StoreError> {
        self.lock()?.execute(
            "UPDATE folders SET uid_validity = ?2 WHERE id = ?1",
            params![folder_id, value],
        )?;
        Ok(())
    }

    /// 이미 처리한 서버 UID(저장하지 않고 건너뛴 중복 메일 포함)
    pub fn known_uids(&self, folder_id: &str) -> Result<HashSet<String>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT remote_id FROM folder_uids WHERE folder_id = ?1")?;
        let rows = stmt.query_map([folder_id], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 저장된 메일의 (읽지 않음, 별표). 키는 서버 UID.
    pub fn local_flags(
        &self,
        folder_id: &str,
    ) -> Result<HashMap<String, (bool, bool)>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT substr(id, length(folder_id) + 2), unread, starred
             FROM messages WHERE folder_id = ?1",
        )?;
        let rows = stmt.query_map([folder_id], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 서버에서 바뀐 읽음·별표를 반영한다.
    pub fn apply_flags(&self, folder_id: &str, flags: &[RemoteFlags]) -> Result<(), StoreError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        {
            let mut update =
                tx.prepare_cached("UPDATE messages SET unread = ?2, starred = ?3 WHERE id = ?1")?;
            for f in flags {
                update.execute(params![
                    format!("{folder_id}-{}", f.remote_id),
                    f.unread,
                    f.starred
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// 서버에서 사라진 메일을 지운다. 이 메일이 차지하고 있던 Gmail 중복 사본은 다시 받을 수 있게 풀어 준다.
    pub fn remove_remote(
        &self,
        account_id: &str,
        folder_id: &str,
        remote_ids: &[String],
    ) -> Result<(), StoreError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        for remote_id in remote_ids {
            remove_row(&tx, account_id, folder_id, remote_id)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 폴더의 로컬 메일과 UID 기록을 모두 비운다(UIDVALIDITY가 바뀐 경우).
    pub fn clear_folder(&self, account_id: &str, folder_id: &str) -> Result<(), StoreError> {
        let ids: Vec<String> = self.known_uids(folder_id)?.into_iter().collect();
        self.remove_remote(account_id, folder_id, &ids)?;
        // 기록에 없는 메일이 남아 있을 수도 있어 한 번 더 지운다.
        self.lock()?
            .execute("DELETE FROM messages WHERE folder_id = ?1", [folder_id])?;
        Ok(())
    }

    /// 계정의 폴더 중 해당 종류의 첫 폴더 (id, key)
    pub fn folder_of_kind(
        &self,
        account_id: &str,
        kind: &str,
    ) -> Result<Option<(String, String)>, StoreError> {
        let id: Option<String> = self
            .lock()?
            .query_row(
                "SELECT id FROM folders WHERE account_id = ?1 AND kind = ?2 ORDER BY position LIMIT 1",
                params![account_id, kind],
                |r| r.get(0),
            )
            .optional()?;
        Ok(id.map(|id| {
            let key = folder_key(account_id, &id);
            (id, key)
        }))
    }

    /// 폴더 id가 이 계정의 폴더인지 확인하고 (종류, key)를 돌려준다.
    pub fn folder_info(
        &self,
        account_id: &str,
        folder_id: &str,
    ) -> Result<Option<(String, String)>, StoreError> {
        let kind: Option<String> = self
            .lock()?
            .query_row(
                "SELECT kind FROM folders WHERE id = ?1 AND account_id = ?2",
                params![folder_id, account_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(kind.map(|k| (k, folder_key(account_id, folder_id))))
    }

    pub fn mail_ref(&self, mail_id: &str) -> Result<Option<MailRef>, StoreError> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT m.account_id, m.folder_id, f.kind, substr(m.id, length(m.folder_id) + 2)
                 FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?1",
                [mail_id],
                |r| {
                    let account_id: String = r.get(0)?;
                    let folder_id: String = r.get(1)?;
                    Ok(MailRef {
                        folder_key: folder_key(&account_id, &folder_id),
                        account_id,
                        folder_id,
                        folder_kind: r.get(2)?,
                        remote_id: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn set_unread(&self, mail_id: &str, unread: bool) -> Result<(), StoreError> {
        self.lock()?.execute(
            "UPDATE messages SET unread = ?2 WHERE id = ?1",
            params![mail_id, unread],
        )?;
        Ok(())
    }

    pub fn set_starred(&self, mail_id: &str, starred: bool) -> Result<(), StoreError> {
        self.lock()?.execute(
            "UPDATE messages SET starred = ?2 WHERE id = ?1",
            params![mail_id, starred],
        )?;
        Ok(())
    }

    /// 로컬에서 메일을 치운다(이동·삭제). 서버 반영은 큐에 넣은 조작이 한다.
    pub fn remove_local(&self, mail: &MailRef) -> Result<(), StoreError> {
        self.remove_remote(
            &mail.account_id,
            &mail.folder_id,
            std::slice::from_ref(&mail.remote_id),
        )
    }

    /// 서버에 보낼 조작을 큐에 넣는다. 같은 메일의 같은 종류 읽음·별표 조작은 마지막 것만 남긴다.
    pub fn enqueue(
        &self,
        account_id: &str,
        kind: OpKind,
        folder_key: &str,
        remote_id: &str,
        arg: &str,
    ) -> Result<(), StoreError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        if matches!(kind, OpKind::Seen | OpKind::Flagged) {
            tx.execute(
                "DELETE FROM pending_ops
                 WHERE account_id = ?1 AND kind = ?2 AND folder_key = ?3 AND remote_id = ?4",
                params![account_id, kind.as_str(), folder_key, remote_id],
            )?;
        }
        tx.execute(
            "INSERT INTO pending_ops (account_id, kind, folder_key, remote_id, arg)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![account_id, kind.as_str(), folder_key, remote_id, arg],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 만든 순서대로의 대기 조작
    pub fn pending_ops(&self, account_id: &str) -> Result<Vec<PendingOp>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, kind, folder_key, remote_id, arg FROM pending_ops
             WHERE account_id = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map([account_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
            ))
        })?;
        let mut ops = Vec::new();
        for row in rows {
            let (id, kind, folder_key, remote_id, arg) = row?;
            if let Some(kind) = OpKind::parse(&kind) {
                ops.push(PendingOp {
                    id,
                    kind,
                    folder_key,
                    remote_id,
                    arg,
                });
            }
        }
        Ok(ops)
    }

    pub fn finish_op(&self, op_id: i64) -> Result<(), StoreError> {
        self.lock()?
            .execute("DELETE FROM pending_ops WHERE id = ?1", [op_id])?;
        Ok(())
    }

    /// 폴더에서 아직 서버에 반영하지 못한 조작이 걸린 메일. 동기화가 이 메일의 로컬 상태를 덮어쓰면 안 된다.
    pub fn pending_remote_ids(
        &self,
        account_id: &str,
        folder_key: &str,
    ) -> Result<HashSet<String>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT remote_id FROM pending_ops WHERE account_id = ?1 AND folder_key = ?2",
        )?;
        let rows = stmt.query_map(params![account_id, folder_key], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

/// 폴더 id에서 계정 접두어(`{계정}-`)를 뗀 서버 key
pub fn folder_key(account_id: &str, folder_id: &str) -> String {
    folder_id
        .strip_prefix(&format!("{account_id}-"))
        .unwrap_or(folder_id)
        .to_string()
}

fn remove_row(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    remote_id: &str,
) -> Result<(), StoreError> {
    let id = format!("{folder}-{remote_id}");
    let owned_key: Option<String> = conn
        .query_row(
            "SELECT dedupe_key FROM messages WHERE id = ?1",
            [&id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    conn.execute("DELETE FROM messages WHERE id = ?1", [&id])?;
    conn.execute(
        "DELETE FROM folder_uids WHERE folder_id = ?1 AND remote_id = ?2",
        params![folder, remote_id],
    )?;
    // 이 메일이 차지하던 중복 사본은 다른 폴더가 새로 차지할 수 있게 기록을 풀어 준다.
    if let Some(key) = owned_key {
        conn.execute(
            "DELETE FROM folder_uids WHERE dedupe_key = ?1 AND folder_id != ?2
               AND folder_id IN (SELECT id FROM folders WHERE account_id = ?3)",
            params![key, folder, account_id],
        )?;
    }
    Ok(())
}
