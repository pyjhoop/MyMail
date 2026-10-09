//! 동기화 엔진. 지금은 계정 추가와 Provider 데이터를 저장소로 옮기는 일만 한다(전체 동기화는 M5).

use crate::auth::{AuthError, CredentialStore};
use crate::providers::{MailProvider, ProviderError};
use crate::store::{NewAccount, Store, StoreError};

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("이미 추가된 계정이에요")]
    Duplicate,
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Provider(#[from] ProviderError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// 계정을 추가한 직후 폴더마다 가져오는 메일 수. 전체 동기화는 M5에서 한다.
const FIRST_LOGIN_FETCH_LIMIT: usize = 100;

/// Provider의 폴더와 메일을 저장소에 반영한다. 폴더마다 최신 `limit`건을 가져온다.
async fn ingest(
    store: &Store,
    account_id: &str,
    provider: &dyn MailProvider,
    limit: usize,
) -> Result<(), SyncError> {
    let folders = provider.list_folders().await?;
    store.save_folders(account_id, &folders)?;
    for folder in &folders {
        let messages = provider.fetch_messages(&folder.key, limit).await?;
        store.save_messages(account_id, &folder.key, &messages)?;
    }
    Ok(())
}

/// 자격 증명을 확인하고 계정을 등록한 뒤 첫 메일을 가져온다.
/// 중간에 실패하면 저장한 계정과 비밀번호를 되돌려, 반쯤 추가된 계정이 남지 않게 한다.
pub async fn add_account(
    store: &Store,
    credentials: &dyn CredentialStore,
    provider: &dyn MailProvider,
    account: NewAccount,
    password: &str,
) -> Result<(), SyncError> {
    if store.account_email_exists(&account.email)? {
        return Err(SyncError::Duplicate);
    }
    provider.verify().await?;
    credentials.save(&account.id, password)?;
    let result = async {
        store.insert_account(&account)?;
        ingest(store, &account.id, provider, FIRST_LOGIN_FETCH_LIMIT).await
    }
    .await;
    if result.is_err() {
        store.delete_account(&account.id)?;
        credentials.delete(&account.id)?;
    }
    result
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::auth::memory::MemoryStore;
    use crate::providers::fake::FakeProvider;
    use crate::providers::{RemoteFolder, RemoteMessage};

    fn new_account(id: &str, email: &str) -> NewAccount {
        NewAccount {
            id: id.into(),
            name: email.into(),
            email: email.into(),
            provider: "naver".into(),
            color_index: 1,
        }
    }

    /// 로그인 또는 조회 단계에서 실패하는 서버
    struct Failing {
        verify: Option<ProviderError>,
    }

    #[async_trait]
    impl MailProvider for Failing {
        async fn verify(&self) -> Result<(), ProviderError> {
            match &self.verify {
                Some(ProviderError::Auth(m)) => Err(ProviderError::Auth(m.clone())),
                _ => Ok(()),
            }
        }

        async fn list_folders(&self) -> Result<Vec<RemoteFolder>, ProviderError> {
            Err(ProviderError::Network("연결 끊김".into()))
        }

        async fn fetch_messages(
            &self,
            _folder_key: &str,
            _limit: usize,
        ) -> Result<Vec<RemoteMessage>, ProviderError> {
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn 계정을_추가하면_비밀번호는_keyring에만_저장되고_메일을_가져온다() {
        let store = Store::open_in_memory().unwrap();
        let creds = MemoryStore::default();
        let fake = FakeProvider::new(1_760_000_000, 30, 0);
        add_account(
            &store,
            &creds,
            &fake,
            new_account("n1", "a@naver.com"),
            "pw",
        )
        .await
        .unwrap();

        assert_eq!(creds.load("n1").unwrap().as_deref(), Some("pw"));
        assert_eq!(store.list_accounts().unwrap().len(), 1);
        assert_eq!(store.list_mails(Some("n1"), "n1-inbox").unwrap().len(), 30);
    }

    #[tokio::test]
    async fn 인증에_실패하면_아무것도_저장하지_않는다() {
        let store = Store::open_in_memory().unwrap();
        let creds = MemoryStore::default();
        let failing = Failing {
            verify: Some(ProviderError::Auth("앱 비밀번호".into())),
        };
        let err = add_account(
            &store,
            &creds,
            &failing,
            new_account("n1", "a@naver.com"),
            "pw",
        )
        .await
        .unwrap_err();

        assert!(matches!(err, SyncError::Provider(ProviderError::Auth(_))));
        assert_eq!(store.account_count().unwrap(), 0);
        assert!(creds.load("n1").unwrap().is_none());
    }

    #[tokio::test]
    async fn 첫_동기화가_실패하면_계정과_비밀번호를_되돌린다() {
        let store = Store::open_in_memory().unwrap();
        let creds = MemoryStore::default();
        let failing = Failing { verify: None };
        let err = add_account(
            &store,
            &creds,
            &failing,
            new_account("n1", "a@naver.com"),
            "pw",
        )
        .await
        .unwrap_err();

        assert!(matches!(
            err,
            SyncError::Provider(ProviderError::Network(_))
        ));
        assert_eq!(store.account_count().unwrap(), 0);
        assert!(creds.load("n1").unwrap().is_none());
    }

    #[tokio::test]
    async fn 같은_이메일은_중복_추가할_수_없다() {
        let store = Store::open_in_memory().unwrap();
        let creds = MemoryStore::default();
        let fake = FakeProvider::new(1_760_000_000, 3, 0);
        add_account(
            &store,
            &creds,
            &fake,
            new_account("n1", "A@naver.com"),
            "pw",
        )
        .await
        .unwrap();
        let err = add_account(
            &store,
            &creds,
            &fake,
            new_account("n2", "a@naver.com"),
            "pw",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, SyncError::Duplicate));
    }
}
