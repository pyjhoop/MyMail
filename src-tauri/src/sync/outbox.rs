//! 사용자 조작(읽음 등)을 서버에 보내는 순서를 정한다. Tauri에 기대지 않아 `FakeProvider`로 시험할 수 있다.
//!
//! - `kick`이 빠르게 연달아 와도(목록을 j·k로 훑는 경우) 짧게 모아 한 번만 보낸다.
//! - 계정마다 보내는 일은 한 번에 하나다. 겹쳐 돌아 같은 조작을 두 번 보내지 않는다.
//! - 연결 오류면 큐를 그대로 두고, 다음 동기화를 기다리지 않고 몇 번 짧게 다시 시도한다.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::Mutex;

use super::{flush_pending, SyncError};
use crate::providers::MailProvider;
use crate::store::Store;

/// 조작이 들어온 뒤 이만큼 기다렸다가 모아서 보낸다.
pub const KICK_DELAY: Duration = Duration::from_millis(300);
/// 연결 오류 뒤 다시 시도하기까지의 대기
pub const RETRY_DELAY: Duration = Duration::from_secs(3);
/// 한 번 깨어 시도하는 최대 횟수(처음 시도 포함). 그래도 안 되면 다음 동기화가 보낸다.
pub const MAX_TRIES: u32 = 3;

#[derive(Default)]
pub struct Outbox {
    /// 모으는 중인 보내기가 있는지
    scheduled: AtomicBool,
    /// 보내는 일은 한 번에 하나
    flushing: Mutex<()>,
}

impl Outbox {
    /// 보내기를 예약한다. 이미 모으는 중이면 `false`(새로 시작하지 않아도 그 보내기에 함께 실린다).
    pub fn claim(&self) -> bool {
        !self.scheduled.swap(true, Ordering::AcqRel)
    }

    /// 큐에 쌓인 조작을 보낸다. 다른 보내기가 돌고 있으면 끝나길 기다렸다가 남은 것만 보낸다.
    pub async fn flush(
        &self,
        store: &Store,
        provider: &dyn MailProvider,
        account_id: &str,
    ) -> Result<Vec<String>, SyncError> {
        let _guard = self.flushing.lock().await;
        flush_pending(store, provider, account_id).await
    }

    /// `claim`이 `true`였던 쪽이 부른다. 모은 뒤 보내고, 연결 오류면 짧게 다시 시도한다.
    /// 이동한 메일의 대상 폴더 key를 돌려준다. 끝내 못 보내면 오류를 돌려주고 큐는 남는다.
    pub async fn run(
        &self,
        store: &Store,
        provider: &dyn MailProvider,
        account_id: &str,
        delay: Duration,
        retry: Duration,
        tries: u32,
    ) -> Result<Vec<String>, SyncError> {
        tokio::time::sleep(delay).await;
        // 이 시점 이후의 조작은 새 보내기로 예약된다.
        self.scheduled.store(false, Ordering::Release);
        let mut attempt = 1;
        loop {
            match self.flush(store, provider, account_id).await {
                Ok(moved) => return Ok(moved),
                Err(e) if attempt >= tries.max(1) => return Err(e),
                Err(_) => {
                    attempt += 1;
                    tokio::time::sleep(retry).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::memory::MemoryStore;
    use crate::providers::fake::FakeProvider;
    use crate::store::NewAccount;
    use crate::sync::{actions, add_account, sync_account, Scope};

    const MS: Duration = Duration::from_millis(5);

    async fn ready() -> (Store, FakeProvider) {
        let store = Store::open_in_memory().unwrap();
        let fake = FakeProvider::new(1_760_000_000, 5, 0);
        let account = NewAccount {
            id: "n1".into(),
            name: "a@naver.com".into(),
            email: "a@naver.com".into(),
            provider: "naver".into(),
            color_index: 1,
        };
        add_account(&store, &MemoryStore::default(), &fake, account, "pw")
            .await
            .unwrap();
        sync_account(&store, &fake, "n1", Scope::All, |_| {})
            .await
            .unwrap();
        (store, fake)
    }

    fn seen_ops(fake: &FakeProvider) -> Vec<String> {
        fake.ops()
            .into_iter()
            .filter(|o| o.starts_with("seen:"))
            .collect()
    }

    #[test]
    fn 모으는_중에는_예약이_한_번만_된다() {
        let outbox = Outbox::default();
        assert!(outbox.claim());
        assert!(!outbox.claim());
    }

    #[tokio::test]
    async fn 모은_읽음_조작을_각각_한_번씩만_보낸다() {
        let (store, fake) = ready().await;
        let outbox = Outbox::default();
        for i in 0..3 {
            actions::set_read(&store, &format!("n1-inbox-{i}"), true).unwrap();
        }
        assert!(outbox.claim());
        outbox
            .run(&store, &fake, "n1", MS, MS, MAX_TRIES)
            .await
            .unwrap();

        assert_eq!(seen_ops(&fake).len(), 3);
        assert!(store.pending_ops("n1").unwrap().is_empty());
        // 보낸 뒤에는 다시 예약할 수 있다.
        assert!(outbox.claim());
    }

    #[tokio::test]
    async fn 겹쳐_돌아도_같은_조작을_두_번_보내지_않는다() {
        let (store, fake) = ready().await;
        let outbox = Outbox::default();
        actions::set_read(&store, "n1-inbox-0", true).unwrap();

        let (a, b) = tokio::join!(
            outbox.flush(&store, &fake, "n1"),
            outbox.flush(&store, &fake, "n1")
        );
        a.unwrap();
        b.unwrap();

        assert_eq!(seen_ops(&fake), vec!["seen:inbox:0:true".to_string()]);
    }

    #[tokio::test]
    async fn 연결이_없으면_큐에_남고_다음_보내기에서_전달된다() {
        let (store, fake) = ready().await;
        let outbox = Outbox::default();
        fake.set_offline(true);
        actions::set_read(&store, "n1-inbox-0", true).unwrap();

        let result = outbox.run(&store, &fake, "n1", MS, MS, 2).await;
        assert!(result.is_err());
        assert_eq!(store.pending_ops("n1").unwrap().len(), 1);

        fake.set_offline(false);
        outbox.run(&store, &fake, "n1", MS, MS, 2).await.unwrap();
        assert_eq!(seen_ops(&fake).len(), 1);
        assert!(store.pending_ops("n1").unwrap().is_empty());
    }

    #[tokio::test]
    async fn 잠깐_끊겼다_돌아오면_짧은_재시도로_보낸다() {
        let (store, fake) = ready().await;
        let outbox = Outbox::default();
        fake.set_offline(true);
        actions::set_read(&store, "n1-inbox-0", true).unwrap();

        let reconnect = async {
            tokio::time::sleep(Duration::from_millis(40)).await;
            fake.set_offline(false);
        };
        let (result, ()) = tokio::join!(
            outbox.run(&store, &fake, "n1", MS, Duration::from_millis(30), 5),
            reconnect
        );
        result.unwrap();
        assert_eq!(seen_ops(&fake).len(), 1);
    }

    #[tokio::test]
    async fn 보내기_전에_동기화가_돌아도_로컬_읽음이_되돌아가지_않는다() {
        let (store, fake) = ready().await;
        actions::set_read(&store, "n1-inbox-0", true).unwrap();
        sync_account(&store, &fake, "n1", Scope::All, |_| {})
            .await
            .unwrap();
        let mail = store.get_mail("n1-inbox-0").unwrap().unwrap();
        assert!(!mail.summary.unread);
    }
}
