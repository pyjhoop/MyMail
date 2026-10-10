//! 서버 변화가 앱에 빨리 반영되는지: 폴더 요약 상태로 건너뛰기, IDLE 빈틈, `sync_now` 합치기.

use std::time::Duration;

use super::scheduler::AccountSync;
use super::*;
use crate::auth::memory::MemoryStore;
use crate::providers::fake::FakeProvider;
use crate::providers::WakeReason;

const NOW: i64 = 1_760_000_000;

async fn added() -> (Store, FakeProvider) {
    let store = Store::open_in_memory().unwrap();
    let fake = FakeProvider::new(NOW, 5, 0);
    add_account(
        &store,
        &MemoryStore::default(),
        &fake,
        NewAccount {
            id: "n1".into(),
            name: "a@naver.com".into(),
            email: "a@naver.com".into(),
            provider: "naver".into(),
            color_index: 1,
        },
        "pw",
    )
    .await
    .unwrap();
    (store, fake)
}

fn snapshots(fake: &FakeProvider, folder: &str) -> usize {
    let wanted = format!("snapshot:{folder}");
    fake.ops().iter().filter(|op| **op == wanted).count()
}

fn count(store: &Store, folder: &str) -> usize {
    store
        .list_mails(Some("n1"), &format!("n1-{folder}"))
        .unwrap()
        .len()
}

fn unread(store: &Store, id: &str) -> bool {
    store.get_mail(id).unwrap().unwrap().summary.unread
}

/// 모든 폴더를 한 번 맞추고 요약 상태를 기록한 캐시를 돌려준다.
async fn synced_once(store: &Store, provider: &dyn MailProvider) -> StatusCache {
    let mut cache = StatusCache::new();
    sync_account_with(
        store,
        provider,
        "n1",
        Scope::All,
        SyncOptions {
            cache: Some(&mut cache),
            ..SyncOptions::default()
        },
        |_| {},
    )
    .await
    .unwrap();
    cache
}

async fn sync_skipping(
    store: &Store,
    provider: &dyn MailProvider,
    cache: &mut StatusCache,
    first: Option<&str>,
) {
    sync_account_with(
        store,
        provider,
        "n1",
        Scope::All,
        SyncOptions {
            cache: Some(cache),
            skip_unchanged: true,
            first,
            refresh_labels: false,
        },
        |_| {},
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn 요약_상태가_같은_폴더는_전체_목록을_받지_않는다() {
    let (store, fake) = added().await;
    let mut cache = synced_once(&store, &fake).await;
    let before = snapshots(&fake, "sent");

    sync_skipping(&store, &fake, &mut cache, None).await;

    assert_eq!(snapshots(&fake, "sent"), before);
}

#[tokio::test]
async fn 웹에서_지운_메일과_바꾼_읽음은_바뀐_폴더만_다시_맞춰_반영된다() {
    let (store, fake) = added().await;
    let mut cache = synced_once(&store, &fake).await;
    let (sent_before, trash_before) = (snapshots(&fake, "sent"), snapshots(&fake, "trash"));
    // 보낸편지함 2번은 읽은 메일(0번만 안 읽음)이었는데 웹에서 안 읽음으로 바꾸고, 1번은 지운다.
    fake.set_unread("sent", "2", true);
    fake.remove("sent", "1");
    assert!(!unread(&store, "n1-sent-2"));

    sync_skipping(&store, &fake, &mut cache, None).await;

    assert!(unread(&store, "n1-sent-2"));
    assert!(store.get_mail("n1-sent-1").unwrap().is_none());
    assert_eq!(snapshots(&fake, "sent"), sent_before + 1);
    assert_eq!(snapshots(&fake, "trash"), trash_before);
}

#[tokio::test]
async fn 개수에_드러나지_않는_변화는_건너뛰지_않는_동기화가_잡는다() {
    let (store, fake) = added().await;
    let mut cache = synced_once(&store, &fake).await;
    // 읽음 상태가 서로 맞바뀌면 안 읽은 수는 그대로다.
    fake.set_unread("sent", "0", false);
    fake.set_unread("sent", "1", true);
    let before = snapshots(&fake, "sent");

    sync_skipping(&store, &fake, &mut cache, None).await;
    assert_eq!(
        snapshots(&fake, "sent"),
        before,
        "요약 상태가 같아 건너뛴다"
    );
    assert!(unread(&store, "n1-sent-0"));

    sync_account_with(
        &store,
        &fake,
        "n1",
        Scope::All,
        SyncOptions {
            cache: Some(&mut cache),
            skip_unchanged: false,
            first: None,
            refresh_labels: false,
        },
        |_| {},
    )
    .await
    .unwrap();
    assert!(!unread(&store, "n1-sent-0"));
    assert!(unread(&store, "n1-sent-1"));
}

#[tokio::test]
async fn 지금_보는_폴더는_요약_상태가_같아도_맞추고_가장_먼저_맞춘다() {
    let (store, fake) = added().await;
    let mut cache = synced_once(&store, &fake).await;
    fake.set_unread("sent", "0", false);
    fake.set_unread("sent", "1", true);
    fake.remove("trash", "0");
    let ops_before = fake.ops().len();

    sync_skipping(&store, &fake, &mut cache, Some("sent")).await;

    assert!(!unread(&store, "n1-sent-0"));
    let order: Vec<String> = fake.ops()[ops_before..]
        .iter()
        .filter(|op| op.starts_with("snapshot:"))
        .cloned()
        .collect();
    assert_eq!(order, ["snapshot:sent", "snapshot:trash"]);
}

#[tokio::test]
async fn 요약_조회를_못_하는_서버는_건너뛰지_않고_전부_맞춘다() {
    struct NoStatus(FakeProvider);

    #[async_trait::async_trait]
    impl MailProvider for NoStatus {
        async fn verify(&self) -> Result<(), ProviderError> {
            self.0.verify().await
        }
        async fn list_folders(&self) -> Result<Vec<RemoteFolder>, ProviderError> {
            self.0.list_folders().await
        }
        async fn fetch_messages(
            &self,
            folder_key: &str,
            limit: usize,
        ) -> Result<Vec<crate::providers::RemoteMessage>, ProviderError> {
            self.0.fetch_messages(folder_key, limit).await
        }
        async fn snapshot(
            &self,
            folder_key: &str,
        ) -> Result<crate::providers::FolderSnapshot, ProviderError> {
            self.0.snapshot(folder_key).await
        }
        async fn fetch_by_ids(
            &self,
            folder_key: &str,
            ids: &[String],
        ) -> Result<Vec<crate::providers::RemoteMessage>, ProviderError> {
            self.0.fetch_by_ids(folder_key, ids).await
        }
    }

    let (store, fake) = added().await;
    let server = NoStatus(fake);
    let mut cache = synced_once(&store, &server).await;
    let before = snapshots(&server.0, "sent");

    sync_skipping(&store, &server, &mut cache, None).await;

    assert_eq!(snapshots(&server.0, "sent"), before + 1);
}

#[tokio::test]
async fn 기다리기_시작할_때_이미_바뀌어_있으면_곧바로_깬다() {
    let (store, fake) = added().await;
    let sync = AccountSync::default();
    sync.round(&store, &fake, "n1", None, |_| {}).await.unwrap();
    let since = sync.baseline("inbox").await;
    assert!(since.is_some());

    let quiet = fake
        .wait_for_changes("inbox", Duration::from_secs(60), since.as_ref())
        .await
        .unwrap();
    assert_eq!(quiet, WakeReason::TimedOut);

    // 동기화가 끝난 뒤 IDLE을 걸기 전에 서버에 새 메일이 왔다.
    fake.deliver("inbox", "그 사이에 온 메일");
    let woke = fake
        .wait_for_changes("inbox", Duration::from_secs(60), since.as_ref())
        .await
        .unwrap();
    assert_eq!(woke, WakeReason::Changed);

    sync.round(&store, &fake, "n1", Some(woke), |_| {})
        .await
        .unwrap();
    assert_eq!(count(&store, "inbox"), 6);
}

#[tokio::test]
async fn 받은편지함_안전망_바퀴는_변화가_없으면_전체_목록을_받지_않는다() {
    let (store, fake) = added().await;
    let sync = AccountSync::default();
    sync.round(&store, &fake, "n1", None, |_| {}).await.unwrap();
    let before = snapshots(&fake, "inbox");

    sync.round(&store, &fake, "n1", Some(WakeReason::TimedOut), |_| {})
        .await
        .unwrap();
    assert_eq!(snapshots(&fake, "inbox"), before);

    // 변화 알림으로 깬 바퀴는 항상 대조한다.
    sync.round(&store, &fake, "n1", Some(WakeReason::Changed), |_| {})
        .await
        .unwrap();
    assert_eq!(snapshots(&fake, "inbox"), before + 1);
}

#[tokio::test]
async fn sync_now는_서버의_삭제와_읽음을_반영한다() {
    let (store, fake) = added().await;
    let sync = AccountSync::default();
    sync.round(&store, &fake, "n1", None, |_| {}).await.unwrap();
    fake.remove("trash", "0");
    fake.set_unread("inbox", "1", true);
    // 직전 동기화가 2초 안이면 합쳐지므로, 시험에서는 합치기 창을 지나게 기다린다.
    tokio::time::sleep(Duration::from_millis(2100)).await;

    sync.sync_now(&store, &fake, "n1", Some("inbox".into()), |_| {})
        .await
        .unwrap();

    assert_eq!(count(&store, "trash"), 2);
    assert!(unread(&store, "n1-inbox-1"));
}

#[tokio::test]
async fn sync_now를_연달아_불러도_한_번만_돈다() {
    let (store, fake) = added().await;
    let sync = AccountSync::default();
    let before = fake.ops().len();

    let (a, b, c) = tokio::join!(
        sync.sync_now(&store, &fake, "n1", None, |_| {}),
        sync.sync_now(&store, &fake, "n1", None, |_| {}),
        sync.sync_now(&store, &fake, "n1", None, |_| {}),
    );
    a.unwrap();
    b.unwrap();
    c.unwrap();
    let once = fake.ops().len();
    sync.sync_now(&store, &fake, "n1", None, |_| {})
        .await
        .unwrap();

    assert!(once > before);
    assert_eq!(fake.ops().len(), once, "방금 끝났으니 다시 돌지 않는다");
    assert_eq!(
        fake.ops().iter().filter(|op| *op == "statuses").count(),
        1,
        "폴더 요약 조회는 한 번의 동기화에 한 번"
    );
}

#[tokio::test]
async fn sync_now가_실패하면_오류를_돌려주고_다음에_다시_돈다() {
    let (store, fake) = added().await;
    let sync = AccountSync::default();
    fake.set_offline(true);

    let err = sync
        .sync_now(&store, &fake, "n1", None, |_| {})
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        SyncError::Provider(ProviderError::Network(_))
    ));

    fake.set_offline(false);
    fake.remove("trash", "0");
    sync.sync_now(&store, &fake, "n1", None, |_| {})
        .await
        .unwrap();
    assert_eq!(count(&store, "trash"), 2);
}

#[test]
fn 열린_폴더_id는_그_계정의_것일_때만_서버_key가_된다() {
    use super::scheduler::open_folder_key;
    assert_eq!(open_folder_key("n1", "n1-sent").as_deref(), Some("sent"));
    assert_eq!(open_folder_key("n1", "g1-sent"), None);
    assert_eq!(open_folder_key("n1", "inbox"), None);
}
