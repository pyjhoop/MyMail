//! 동기화 엔진. M2에서는 Provider가 준 데이터를 저장소에 옮기는 일만 한다.

use crate::providers::fake::FakeProvider;
use crate::providers::{MailProvider, ProviderError};
use crate::store::{NewAccount, Store, StoreError};

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Provider(#[from] ProviderError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

const INITIAL_FETCH_LIMIT: usize = 5000;

/// Provider의 폴더와 메일을 저장소에 반영한다.
pub async fn ingest(
    store: &Store,
    account_id: &str,
    provider: &dyn MailProvider,
) -> Result<(), SyncError> {
    let folders = provider.list_folders().await?;
    store.save_folders(account_id, &folders)?;
    for folder in &folders {
        let messages = provider
            .fetch_messages(&folder.key, INITIAL_FETCH_LIMIT)
            .await?;
        store.save_messages(account_id, &folder.key, &messages)?;
    }
    Ok(())
}

/// 계정이 하나도 없으면 가짜 계정 3개를 만든다.
/// 계정 추가 화면(M3)이 생기면 제거한다.
pub async fn seed_fake_accounts(store: &Store, now: i64) -> Result<(), SyncError> {
    if store.account_count()? > 0 {
        return Ok(());
    }
    let accounts = [
        ("a1", "개인 Gmail", "junho.park@gmail.com", "gmail", 1, 2000),
        (
            "a2",
            "프로젝트 Gmail",
            "junho.dev@gmail.com",
            "gmail",
            2,
            300,
        ),
        ("a3", "네이버", "junho_p@naver.com", "naver", 3, 300),
    ];
    for (i, (id, name, email, provider, color_index, inbox)) in accounts.into_iter().enumerate() {
        store.insert_account(&NewAccount {
            id: id.into(),
            name: name.into(),
            email: email.into(),
            provider: provider.into(),
            color_index,
        })?;
        ingest(store, id, &FakeProvider::new(now, inbox, i)).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn 시드는_한_번만_실행된다() {
        let store = Store::open_in_memory().unwrap();
        seed_fake_accounts(&store, 1_760_000_000).await.unwrap();
        seed_fake_accounts(&store, 1_760_000_000).await.unwrap();
        assert_eq!(store.list_accounts().unwrap().len(), 3);
        assert_eq!(store.list_mails(None, "").unwrap().len(), 2600);
    }
}
