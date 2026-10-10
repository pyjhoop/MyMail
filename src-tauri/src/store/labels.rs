//! 메일의 라벨을 로컬에서 바꾸는 조작과 라벨별 메일 모아 보기.

use rusqlite::{params, Connection, OptionalExtension};

use super::{Store, StoreError};

/// 폴더 `f`(라벨)에 속한 메일 `m`인 조건. 라벨은 메일이 저장된 폴더가 아니라 붙은 라벨로 정한다.
/// 라벨 목록이 아직 없는 옛 행은 저장된 폴더로 판단한다.
pub(super) const LABEL_MEMBER_SQL: &str =
    "(m.account_id = f.account_id AND ((m.labels IS NULL AND m.folder_id = f.id)
        OR (m.labels IS NOT NULL AND EXISTS
            (SELECT 1 FROM json_each(m.labels) j WHERE j.value = COALESCE(f.path, f.name)))))";

/// 라벨 폴더(`?1`)와 그 전체 이름(`?2`)으로 메일을 고르는 조건
pub(super) const LABEL_VIEW_SQL: &str =
    "(m.account_id = (SELECT account_id FROM folders WHERE id = ?1)
      AND ((m.labels IS NULL AND m.folder_id = ?1)
        OR (m.labels IS NOT NULL AND EXISTS
            (SELECT 1 FROM json_each(m.labels) j WHERE j.value = ?2))))";

/// 폴더가 라벨이면 그 전체 이름
pub(super) fn label_path(
    conn: &Connection,
    folder_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT COALESCE(path, name) FROM folders WHERE id = ?1 AND kind = 'label'",
        [folder_id],
        |r| r.get(0),
    )
    .optional()
}

fn write_labels(conn: &Connection, mail_id: &str, labels: &[String]) -> Result<(), StoreError> {
    conn.execute(
        "UPDATE messages SET labels = ?2, label_name = ?3 WHERE id = ?1",
        params![
            mail_id,
            // 빈 목록도 "[]"로 적는다. NULL이면 옛 행으로 보고 저장된 폴더의 라벨이 붙은 것으로 취급한다.
            serde_json::to_string(labels).unwrap_or_default(),
            labels.first()
        ],
    )?;
    Ok(())
}

fn parse_labels(json: Option<String>, first: Option<String>) -> Vec<String> {
    json.and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_else(|| first.into_iter().collect())
}

impl Store {
    /// 메일에 붙은 라벨(시스템 라벨 제외). 없는 메일이면 `None`.
    pub fn mail_labels(&self, mail_id: &str) -> Result<Option<Vec<String>>, StoreError> {
        let row: Option<(Option<String>, Option<String>)> = self
            .lock()?
            .query_row(
                "SELECT labels, label_name FROM messages WHERE id = ?1",
                [mail_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row.map(|(json, first)| parse_labels(json, first)))
    }

    pub fn set_mail_labels(&self, mail_id: &str, labels: &[String]) -> Result<(), StoreError> {
        let conn = self.lock()?;
        write_labels(&conn, mail_id, labels)
    }

    /// 라벨 폴더의 전체 이름. 이 계정의 라벨 폴더가 아니면 `None`.
    pub fn label_path_of(
        &self,
        account_id: &str,
        folder_id: &str,
    ) -> Result<Option<String>, StoreError> {
        let conn = self.lock()?;
        let path = label_path(&conn, folder_id)?;
        let owned: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1 AND account_id = ?2)",
            params![folder_id, account_id],
            |r| r.get(0),
        )?;
        Ok(path.filter(|_| owned))
    }

    /// 계정의 라벨 폴더 중 전체 이름이 `path`인 것의 (폴더 id, 서버 key)
    pub fn label_folder(
        &self,
        account_id: &str,
        path: &str,
    ) -> Result<Option<(String, String)>, StoreError> {
        let id: Option<String> = self
            .lock()?
            .query_row(
                "SELECT id FROM folders
                 WHERE account_id = ?1 AND kind = 'label' AND COALESCE(path, name) = ?2",
                params![account_id, path],
                |r| r.get(0),
            )
            .optional()?;
        Ok(id.map(|id| {
            let key = super::folder_key(account_id, &id);
            (id, key)
        }))
    }

    /// 라벨이 아닌 폴더(받은편지함·보낸편지함 등)의 이름. 라벨 이름으로 쓸 수 없다.
    pub fn non_label_folder_names(&self, account_id: &str) -> Result<Vec<String>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT COALESCE(path, name) FROM folders WHERE account_id = ?1 AND kind != 'label'",
        )?;
        let rows = stmt.query_map([account_id], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 계정의 모든 메일의 라벨 이름에 `map`을 적용한다(`None`을 돌려주면 그 라벨을 뗀다).
    /// 바뀐 메일만 쓴다. 바뀐 메일 수를 돌려준다.
    pub fn rewrite_labels(
        &self,
        account_id: &str,
        map: impl Fn(&str) -> Option<String>,
    ) -> Result<usize, StoreError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let rows: Vec<(String, Option<String>, Option<String>)> = {
            let mut stmt = tx.prepare(
                "SELECT id, labels, label_name FROM messages
                 WHERE account_id = ?1 AND (labels IS NOT NULL OR label_name IS NOT NULL)",
            )?;
            let rows = stmt.query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut changed = 0;
        for (id, json, first) in rows {
            let old = parse_labels(json, first);
            let mut new: Vec<String> = Vec::with_capacity(old.len());
            for label in &old {
                if let Some(mapped) = map(label) {
                    if !new.contains(&mapped) {
                        new.push(mapped);
                    }
                }
            }
            if new != old {
                write_labels(&tx, &id, &new)?;
                changed += 1;
            }
        }
        tx.commit()?;
        Ok(changed)
    }
}
