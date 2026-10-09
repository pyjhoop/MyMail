//! 첨부 내려받기에 필요한 조회.

use rusqlite::params;

use super::sync_state::MailRef;
use super::{Store, StoreError};
use crate::providers::AttachmentTarget;

/// 저장된 첨부 한 건과 그 첨부가 속한 서버 메일
#[derive(Debug, Clone)]
pub struct AttachmentRef {
    pub id: i64,
    pub mail: MailRef,
    pub target: AttachmentTarget,
}

impl Store {
    /// 메일에 딸린 첨부 전체(저장된 순서)
    pub fn attachment_refs(&self, mail_id: &str) -> Result<Vec<AttachmentRef>, StoreError> {
        let Some(mail) = self.mail_ref(mail_id)? else {
            return Ok(Vec::new());
        };
        let conn = self.lock()?;
        let rows = conn
            .prepare(
                "SELECT id, name, size, part_index FROM attachments
                 WHERE message_id = ?1 ORDER BY id",
            )?
            .query_map(params![mail_id], |r| {
                Ok(AttachmentRef {
                    id: r.get(0)?,
                    mail: mail.clone(),
                    target: AttachmentTarget {
                        name: r.get(1)?,
                        size: r.get::<_, i64>(2)?.max(0) as u64,
                        part_index: r.get(3)?,
                    },
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn attachment_ref(
        &self,
        mail_id: &str,
        attachment_id: i64,
    ) -> Result<Option<AttachmentRef>, StoreError> {
        Ok(self
            .attachment_refs(mail_id)?
            .into_iter()
            .find(|a| a.id == attachment_id))
    }
}
