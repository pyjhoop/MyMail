//! 데이터 초기화의 저장소·keyring 쪽 일. 동기화 중지·재시작은 command가 맡는다.

use serde::Deserialize;

use crate::auth::CredentialStore;
use crate::store::{Store, StoreError};

/// 무엇을 지울지
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetScope {
    /// 메일 캐시만(계정·비밀번호 유지)
    Cache,
    /// 계정·비밀번호·캐시·설정 전부
    All,
}

#[derive(Debug, thiserror::Error)]
pub enum ResetError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("저장된 비밀번호를 지우지 못했어요.")]
    Credentials,
}

/// 범위에 맞게 지운다. 전체 범위는 비밀번호를 먼저 지우고, 하나라도 실패하면 DB는 그대로 둔다(다시 시도할 수 있게).
/// 두 번 불러도 안전하다.
pub fn apply(
    store: &Store,
    credentials: &dyn CredentialStore,
    scope: ResetScope,
) -> Result<(), ResetError> {
    match scope {
        ResetScope::Cache => store.clear_mail_cache()?,
        ResetScope::All => {
            let mut failed = false;
            for account in store.list_accounts()? {
                failed |= credentials.delete(&account.id).is_err();
            }
            if failed {
                return Err(ResetError::Credentials);
            }
            store.clear_all_data()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::memory::MemoryStore;
    use crate::auth::AuthError;
    use crate::providers::fake::FakeProvider;
    use crate::providers::MailProvider;
    use crate::store::NewAccount;

    fn new_account(id: &str) -> NewAccount {
        NewAccount {
            id: id.into(),
            name: id.into(),
            email: format!("{id}@gmail.com"),
            provider: "gmail".into(),
            color_index: 1,
        }
    }

    async fn seeded(creds: &dyn CredentialStore) -> Store {
        let store = Store::open_in_memory().unwrap();
        let p = FakeProvider::new(1_760_000_000, 10, 0);
        for id in ["a1", "a2"] {
            store.insert_account(&new_account(id)).unwrap();
            creds.save(id, "secret").unwrap();
            store
                .save_folders(id, &p.list_folders().await.unwrap())
                .unwrap();
            for f in p.list_folders().await.unwrap() {
                let msgs = p.fetch_messages(&f.key, 100).await.unwrap();
                store.save_messages(id, &f.key, &msgs).unwrap();
            }
        }
        store
    }

    fn count(store: &Store, table: &str) -> i64 {
        store.count_rows(table)
    }

    #[tokio::test]
    async fn 캐시_범위는_계정과_비밀번호를_남기고_메일만_지운다() {
        let creds = MemoryStore::default();
        let store = seeded(&creds).await;
        assert!(count(&store, "messages") > 0);
        apply(&store, &creds, ResetScope::Cache).unwrap();
        assert_eq!(count(&store, "messages"), 0);
        assert_eq!(count(&store, "folder_uids"), 0);
        assert_eq!(count(&store, "sender_stats"), 0);
        assert_eq!(store.account_count().unwrap(), 2);
        assert!(count(&store, "folders") > 0);
        assert_eq!(creds.load("a1").unwrap().as_deref(), Some("secret"));
        // 다음 동기화가 처음부터 다시 받을 수 있다.
        let p = FakeProvider::new(1_760_000_000, 10, 0);
        let f = &p.list_folders().await.unwrap()[0];
        let msgs = p.fetch_messages(&f.key, 100).await.unwrap();
        store.save_messages("a1", &f.key, &msgs).unwrap();
        assert!(count(&store, "messages") > 0);
    }

    #[tokio::test]
    async fn 전체_범위는_계정과_비밀번호까지_지운다() {
        let creds = MemoryStore::default();
        let store = seeded(&creds).await;
        apply(&store, &creds, ResetScope::All).unwrap();
        assert_eq!(store.account_count().unwrap(), 0);
        for t in ["messages", "folders", "pending_ops", "compose_mails"] {
            assert_eq!(count(&store, t), 0, "{t}");
        }
        assert_eq!(creds.load("a1").unwrap(), None);
        assert_eq!(creds.load("a2").unwrap(), None);
        // 두 번 불러도 안전하고, 초기화 뒤 계정을 다시 추가할 수 있다.
        apply(&store, &creds, ResetScope::All).unwrap();
        apply(&store, &creds, ResetScope::Cache).unwrap();
        store.insert_account(&new_account("a3")).unwrap();
        assert_eq!(store.account_count().unwrap(), 1);
    }

    struct FailingStore;
    impl CredentialStore for FailingStore {
        fn save(&self, _: &str, _: &str) -> Result<(), AuthError> {
            Ok(())
        }
        fn load(&self, _: &str) -> Result<Option<String>, AuthError> {
            Ok(None)
        }
        fn delete(&self, _: &str) -> Result<(), AuthError> {
            Err(AuthError::Keyring("실패".into()))
        }
    }

    #[tokio::test]
    async fn 비밀번호를_못_지우면_데이터는_그대로_둔다() {
        let creds = MemoryStore::default();
        let store = seeded(&creds).await;
        let err = apply(&store, &FailingStore, ResetScope::All).unwrap_err();
        assert!(matches!(err, ResetError::Credentials));
        assert_eq!(store.account_count().unwrap(), 2);
        assert!(count(&store, "messages") > 0);
    }
}
