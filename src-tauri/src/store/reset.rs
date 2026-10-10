//! 데이터 초기화: 저장한 메일 캐시나 앱 데이터 전체를 지운다. 서버의 메일은 건드리지 않는다.

use super::{Store, StoreError};

impl Store {
    /// 메일 캐시만 지운다. 계정·폴더·설정·작성 중인 메일은 남기고,
    /// 폴더의 UIDVALIDITY를 비워 다음 동기화 때 서버에서 전부 다시 받게 한다.
    pub fn clear_mail_cache(&self) -> Result<(), StoreError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        // 서버에 반영하지 못한 조작(pending_ops)도 지운다. 캐시가 없으면 대상 메일이 없다.
        tx.execute_batch(
            "DELETE FROM pending_ops;
             DELETE FROM folder_uids;
             DELETE FROM messages;
             DELETE FROM sender_stats;
             UPDATE folders SET uid_validity = NULL;",
        )?;
        tx.commit()?;
        Self::compact(&conn);
        Ok(())
    }

    /// 계정과 모든 캐시·설정을 지워 처음 실행 상태로 되돌린다(계정에 딸린 표는 CASCADE로 함께 지워진다).
    pub fn clear_all_data(&self) -> Result<(), StoreError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        tx.execute_batch(
            "DELETE FROM pending_ops;
             DELETE FROM compose_mails;
             DELETE FROM messages;
             DELETE FROM folders;
             DELETE FROM accounts;
             DELETE FROM sender_stats;
             DELETE FROM app_settings;",
        )?;
        tx.commit()?;
        Self::compact(&conn);
        Ok(())
    }

    /// 표의 행 수(테스트용)
    #[cfg(test)]
    pub(crate) fn count_rows(&self, table: &str) -> i64 {
        self.lock()
            .unwrap()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// 지운 공간을 돌려주고 WAL 파일을 비운다. 실패해도 지우기 자체는 끝났으므로 무시한다.
    fn compact(conn: &rusqlite::Connection) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
    }
}
