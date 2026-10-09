//! 동기화 엔진. 지금은 계정 추가, 첫 메일 가져오기, 백그라운드 채우기만 한다(전체 동기화는 M5).

use crate::auth::{AuthError, CredentialStore};
use crate::providers::{FolderKind, MailProvider, ProviderError, RemoteFolder};
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

/// 계정을 추가하는 순간 받는 받은편지함 메일 수. 화면을 빨리 띄우기 위해 작게 둔다.
const FIRST_LOGIN_FETCH_LIMIT: usize = 30;
/// 백그라운드에서 폴더마다 받는 메일 수. 전체 동기화는 M5에서 한다.
const BACKFILL_LIMIT: usize = 100;

/// 백그라운드 동기화 진행 상황. UI가 진행률 막대로 보여 준다.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub account_id: String,
    pub done: usize,
    pub total: usize,
    /// 중간에 실패했을 때의 안내. 이미 받은 메일은 남는다.
    pub error: Option<String>,
}

/// 폴더 목록을 저장하고 받은편지함만 먼저 가져온다. 나머지 폴더는 `backfill`이 받는다.
async fn ingest_first(
    store: &Store,
    account_id: &str,
    provider: &dyn MailProvider,
) -> Result<Vec<RemoteFolder>, SyncError> {
    let folders = provider.list_folders().await?;
    store.save_folders(account_id, &folders)?;
    if let Some(inbox) = folders.iter().find(|f| f.kind == FolderKind::Inbox) {
        let messages = provider
            .fetch_messages(&inbox.key, FIRST_LOGIN_FETCH_LIMIT)
            .await?;
        store.save_messages(account_id, &inbox.key, &messages)?;
    }
    Ok(folders)
}

/// 자격 증명을 확인하고 계정을 등록한 뒤 받은편지함 첫 메일을 가져온다. 폴더 목록을 돌려준다.
/// 중간에 실패하면 저장한 계정과 비밀번호를 되돌려, 반쯤 추가된 계정이 남지 않게 한다.
pub async fn add_account(
    store: &Store,
    credentials: &dyn CredentialStore,
    provider: &dyn MailProvider,
    account: NewAccount,
    password: &str,
) -> Result<Vec<RemoteFolder>, SyncError> {
    if store.account_email_exists(&account.email)? {
        return Err(SyncError::Duplicate);
    }
    provider.verify().await?;
    credentials.save(&account.id, password)?;
    let result = async {
        store.insert_account(&account)?;
        ingest_first(store, &account.id, provider).await
    }
    .await;
    if result.is_err() {
        store.delete_account(&account.id)?;
        credentials.delete(&account.id)?;
    }
    result
}

/// 모든 폴더의 최신 메일을 받는다. 폴더 하나가 끝날 때마다 `report`로 알린다.
/// 실패해도 계정은 지우지 않고, 오류를 담은 진행 상황을 한 번 알린 뒤 멈춘다.
pub async fn backfill(
    store: &Store,
    account_id: &str,
    provider: &dyn MailProvider,
    folders: &[RemoteFolder],
    report: impl Fn(Progress),
) {
    let total = folders.len();
    let progress = |done, error| Progress {
        account_id: account_id.into(),
        done,
        total,
        error,
    };
    report(progress(0, None));
    for (i, folder) in folders.iter().enumerate() {
        let result = async {
            let messages = provider.fetch_messages(&folder.key, BACKFILL_LIMIT).await?;
            store.save_messages(account_id, &folder.key, &messages)?;
            Ok::<_, SyncError>(())
        }
        .await;
        match result {
            Ok(()) => report(progress(i + 1, None)),
            Err(e) => {
                report(progress(i, Some(e.to_string())));
                return;
            }
        }
    }
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

    #[tokio::test]
    async fn 계정_추가는_받은편지함_일부만_받고_나머지는_백그라운드로_받는다() {
        let store = Store::open_in_memory().unwrap();
        let creds = MemoryStore::default();
        let fake = FakeProvider::new(1_760_000_000, 80, 0);
        let folders = add_account(
            &store,
            &creds,
            &fake,
            new_account("n1", "a@naver.com"),
            "pw",
        )
        .await
        .unwrap();
        assert_eq!(store.list_mails(Some("n1"), "n1-inbox").unwrap().len(), 30);

        let reports = std::cell::RefCell::new(Vec::new());
        backfill(&store, "n1", &fake, &folders, |p| {
            reports.borrow_mut().push(p)
        })
        .await;

        assert_eq!(store.list_mails(Some("n1"), "n1-inbox").unwrap().len(), 80);
        let reports = reports.into_inner();
        let total = folders.len();
        assert_eq!(reports.first().map(|p| p.done), Some(0));
        let last = reports.last().unwrap();
        assert_eq!(
            (last.done, last.total, last.error.clone()),
            (total, total, None)
        );
    }

    /// 두 번째 폴더부터 실패하는 서버
    struct FailsAfterFirst(FakeProvider);

    #[async_trait]
    impl MailProvider for FailsAfterFirst {
        async fn verify(&self) -> Result<(), ProviderError> {
            Ok(())
        }

        async fn list_folders(&self) -> Result<Vec<RemoteFolder>, ProviderError> {
            self.0.list_folders().await
        }

        async fn fetch_messages(
            &self,
            folder_key: &str,
            limit: usize,
        ) -> Result<Vec<RemoteMessage>, ProviderError> {
            if folder_key.ends_with("inbox") {
                self.0.fetch_messages(folder_key, limit).await
            } else {
                Err(ProviderError::Network("연결 끊김".into()))
            }
        }
    }

    #[tokio::test]
    async fn 백그라운드_동기화가_실패해도_계정과_받은_메일은_남고_오류를_알린다() {
        let store = Store::open_in_memory().unwrap();
        let creds = MemoryStore::default();
        let server = FailsAfterFirst(FakeProvider::new(1_760_000_000, 5, 0));
        let folders = add_account(
            &store,
            &creds,
            &server,
            new_account("n1", "a@naver.com"),
            "pw",
        )
        .await
        .unwrap();

        let reports = std::cell::RefCell::new(Vec::new());
        backfill(&store, "n1", &server, &folders, |p| {
            reports.borrow_mut().push(p)
        })
        .await;

        let last = reports.into_inner().pop().unwrap();
        assert_eq!(last.done, 1);
        assert!(last.error.unwrap().contains("연결 끊김"));
        assert_eq!(store.account_count().unwrap(), 1);
        assert_eq!(store.list_mails(Some("n1"), "n1-inbox").unwrap().len(), 5);
    }
}
