//! 새 메일 알림에 쓰는 조회와 설정: 동기화 전후로 새로 들어온 안 읽은 메일을 찾고, 계정별 알림 설정을 읽고 쓴다.

use rusqlite::params;

use super::{Store, StoreError};

/// 알림에 보여 줄 새 메일
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMail {
    pub sender: String,
    pub subject: String,
    pub preview: String,
}

/// 계정별 알림 설정
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifySettings {
    pub enabled: bool,
    /// `inbox` | `all` | `starred`
    pub scope: String,
    pub sound: bool,
    pub badge: bool,
}

impl Default for NotifySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            scope: "inbox".into(),
            sound: true,
            badge: true,
        }
    }
}

const PAUSED_UNTIL: &str = "notify_paused_until";

impl Store {
    /// 계정의 가장 최근에 저장된 메일 위치. 동기화 전에 기록해 두고, 이후 `new_unread`에 넘긴다.
    pub fn mail_watermark(&self, account_id: &str) -> Result<i64, StoreError> {
        let conn = self.lock()?;
        Ok(conn.query_row(
            "SELECT COALESCE(MAX(rowid), 0) FROM messages WHERE account_id = ?1",
            [account_id],
            |r| r.get(0),
        )?)
    }

    /// `watermark` 이후 저장된 안 읽은 메일 중 `scope`에 맞는 것, 오래된 것부터.
    /// `inbox`는 받은편지함만, `all`은 보낸편지함·임시보관함·휴지통·스팸함을 뺀 모든 폴더,
    /// `starred`는 받은편지함 중 별표한 메일이 있는 보낸사람(주소 기준)의 메일만.
    pub fn new_unread(
        &self,
        account_id: &str,
        watermark: i64,
        scope: &str,
    ) -> Result<Vec<NewMail>, StoreError> {
        let folder_rule = match scope {
            "all" => "f.kind NOT IN ('sent', 'drafts', 'trash', 'spam')",
            "starred" => {
                "f.kind = 'inbox' AND EXISTS (SELECT 1 FROM messages s
                   WHERE s.account_id = m.account_id AND s.sender_email = m.sender_email AND s.starred = 1)"
            }
            _ => "f.kind = 'inbox'",
        };
        let conn = self.lock()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT m.sender, m.subject, m.preview FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE m.account_id = ?1 AND m.rowid > ?2 AND m.unread = 1 AND {folder_rule}
             ORDER BY m.rowid"
        ))?;
        let rows = stmt.query_map(params![account_id, watermark], |r| {
            Ok(NewMail {
                sender: r.get(0)?,
                subject: r.get(1)?,
                preview: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn notify_settings(&self, account_id: &str) -> Result<NotifySettings, StoreError> {
        let conn = self.lock()?;
        Ok(conn
            .query_row(
                "SELECT notify_enabled, notify_scope, notify_sound, notify_badge FROM accounts WHERE id = ?1",
                [account_id],
                |r| {
                    Ok(NotifySettings {
                        enabled: r.get(0)?,
                        scope: r.get(1)?,
                        sound: r.get(2)?,
                        badge: r.get(3)?,
                    })
                },
            )
            .unwrap_or_default())
    }

    pub fn set_notify_settings(
        &self,
        account_id: &str,
        settings: &NotifySettings,
    ) -> Result<(), StoreError> {
        self.lock()?.execute(
            "UPDATE accounts SET notify_enabled = ?2, notify_scope = ?3, notify_sound = ?4, notify_badge = ?5
             WHERE id = ?1",
            params![
                account_id,
                settings.enabled,
                settings.scope,
                settings.sound,
                settings.badge
            ],
        )?;
        Ok(())
    }

    /// 알림 일시 중지가 풀리는 시각(유닉스 초). 중지 중이 아니면 `None`.
    pub fn notify_paused_until(&self) -> Result<Option<i64>, StoreError> {
        let conn = self.lock()?;
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [PAUSED_UNTIL],
                |r| r.get(0),
            )
            .ok();
        Ok(value.and_then(|v| v.parse().ok()))
    }

    pub fn set_notify_paused_until(&self, until: Option<i64>) -> Result<(), StoreError> {
        let conn = self.lock()?;
        match until {
            Some(t) => conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![PAUSED_UNTIL, t.to_string()],
            )?,
            None => conn.execute("DELETE FROM app_settings WHERE key = ?1", [PAUSED_UNTIL])?,
        };
        Ok(())
    }

    /// 안 읽은 받은편지함 메일 수: (전체, 작업 표시줄 표시를 켠 계정만)
    pub fn unread_counts(&self) -> Result<(u32, u32), StoreError> {
        let conn = self.lock()?;
        Ok(conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(a.notify_badge), 0)
             FROM messages m JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id
             WHERE f.kind = 'inbox' AND m.unread = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }
}
