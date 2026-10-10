use std::cell::RefCell;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;

use super::*;
use crate::auth::memory::MemoryStore;
use crate::providers::fake::FakeProvider;
use crate::providers::{FolderSnapshot, RemoteFolder, RemoteMessage};

const NOW: i64 = 1_760_000_000;

fn new_account(id: &str, email: &str) -> NewAccount {
    NewAccount {
        id: id.into(),
        name: email.into(),
        email: email.into(),
        provider: "naver".into(),
        color_index: 1,
    }
}

/// 계정 `n1`을 추가한 상태(받은편지함 최신 30통만 받음)
async fn added(inbox_count: usize) -> (Store, FakeProvider) {
    let store = Store::open_in_memory().unwrap();
    let fake = FakeProvider::new(NOW, inbox_count, 0);
    add_account(
        &store,
        &MemoryStore::default(),
        &fake,
        new_account("n1", "a@naver.com"),
        "pw",
    )
    .await
    .unwrap();
    (store, fake)
}

/// 알림을 모아 두는 도구
#[derive(Default)]
struct Reports(RefCell<Vec<Progress>>);

impl Reports {
    fn sink(&self) -> impl Fn(Progress) + '_ {
        |p| self.0.borrow_mut().push(p)
    }

    fn last(&self) -> Progress {
        self.0.borrow().last().cloned().unwrap()
    }
}

async fn sync_all(store: &Store, provider: &dyn MailProvider) -> Reports {
    let reports = Reports::default();
    sync_account(store, provider, "n1", Scope::All, reports.sink())
        .await
        .unwrap();
    reports
}

fn inbox_count(store: &Store) -> usize {
    store.list_mails(Some("n1"), "n1-inbox").unwrap().len()
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

/// 메일 받기 요청을 정해진 횟수까지만 들어주는 서버. 나머지는 가짜 서버에 맡긴다.
struct Flaky {
    inner: FakeProvider,
    fetches_left: AtomicUsize,
    fetch_calls: AtomicUsize,
}

impl Flaky {
    fn new(inner: FakeProvider, allowed_fetches: usize) -> Self {
        Self {
            inner,
            fetches_left: AtomicUsize::new(allowed_fetches),
            fetch_calls: AtomicUsize::new(0),
        }
    }

    fn allow(&self, n: usize) {
        self.fetches_left.store(n, Ordering::SeqCst);
    }
}

#[async_trait]
impl MailProvider for Flaky {
    async fn verify(&self) -> Result<(), ProviderError> {
        self.inner.verify().await
    }

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, ProviderError> {
        self.inner.list_folders().await
    }

    async fn fetch_messages(
        &self,
        folder_key: &str,
        limit: usize,
    ) -> Result<Vec<RemoteMessage>, ProviderError> {
        self.inner.fetch_messages(folder_key, limit).await
    }

    async fn snapshot(&self, folder_key: &str) -> Result<FolderSnapshot, ProviderError> {
        self.inner.snapshot(folder_key).await
    }

    async fn fetch_by_ids(
        &self,
        folder_key: &str,
        ids: &[String],
    ) -> Result<Vec<RemoteMessage>, ProviderError> {
        let allowed = self
            .fetches_left
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok();
        if !allowed {
            return Err(ProviderError::Network("연결 끊김".into()));
        }
        self.fetch_calls.fetch_add(1, Ordering::SeqCst);
        self.inner.fetch_by_ids(folder_key, ids).await
    }
}

#[tokio::test]
async fn 계정을_추가하면_비밀번호는_keyring에만_저장되고_메일을_가져온다() {
    let store = Store::open_in_memory().unwrap();
    let creds = MemoryStore::default();
    let fake = FakeProvider::new(NOW, 30, 0);
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
    assert_eq!(inbox_count(&store), 30);
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
    let fake = FakeProvider::new(NOW, 3, 0);
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
async fn 전체_동기화는_모든_폴더의_메일을_받고_진행률을_알린다() {
    let (store, fake) = added(250).await;
    assert_eq!(inbox_count(&store), 30);

    let reports = sync_all(&store, &fake).await;

    assert_eq!(inbox_count(&store), 250);
    // 받은편지함 220통 + 보낸·임시·스팸·휴지통 3통씩 + 라벨 셋과 폴더 둘 2통씩
    let total = 220 + 12 + 10;
    let all = reports.0.borrow();
    assert_eq!((all[0].done, all[0].total), (0, total));
    assert!(all.windows(2).all(|w| w[0].done <= w[1].done));
    let last = all.last().unwrap();
    assert_eq!(
        (last.done, last.total, last.error.clone()),
        (total, total, None)
    );
}

#[tokio::test]
async fn 진행률은_처음_받은_30통을_빼고_남은_수만_센다() {
    let (store, fake) = added(40).await;
    assert_eq!(inbox_count(&store), 30);

    let reports = sync_all(&store, &fake).await;

    // 받은편지함 10통 + 보낸·임시·스팸·휴지통 3통씩 + 라벨 셋과 폴더 둘 2통씩
    let total = 10 + 12 + 10;
    let all = reports.0.borrow();
    assert!(all.iter().all(|p| p.total == total));
    assert_eq!((all[0].done, all[0].total), (0, total));
    let last = all.last().unwrap();
    assert_eq!((last.done, last.total), (total, total));
    assert_eq!(inbox_count(&store), 40);
}

#[tokio::test]
async fn 각_폴더의_최신_메일을_먼저_받는다() {
    let (store, fake) = added(1000).await;
    let flaky = Flaky::new(fake, 0);
    // 폴더마다 첫 묶음(최신 100통)만 받게 한다: 폴더 10개에 한 번씩
    flaky.allow(10);
    let reports = Reports::default();
    let err = sync_account(&store, &flaky, "n1", Scope::All, reports.sink())
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        SyncError::Provider(ProviderError::Network(_))
    ));

    // 받은편지함은 처음 받은 30통에 최신 100통이 더해지고, 다른 폴더도 이미 받았다.
    assert_eq!(inbox_count(&store), 130);
    assert_eq!(store.list_mails(Some("n1"), "n1-sent").unwrap().len(), 3);
    let last = reports.last();
    assert!(last.error.unwrap().contains("연결 끊김"));
}

#[tokio::test]
async fn 끊긴_동기화는_받은_것을_건너뛰고_이어받는다() {
    let (store, fake) = added(120).await;
    let flaky = Flaky::new(fake, 0);
    flaky.allow(3);
    assert!(sync_account(&store, &flaky, "n1", Scope::All, |_| {})
        .await
        .is_err());
    let received = flaky.fetch_calls.load(Ordering::SeqCst);
    assert_eq!(received, 3);
    let after_first: usize = store.list_mails(None, "").unwrap().len();

    flaky.allow(100);
    flaky.fetch_calls.store(0, Ordering::SeqCst);
    let reports = Reports::default();
    sync_account(&store, &flaky, "n1", Scope::All, reports.sink())
        .await
        .unwrap();

    assert_eq!(inbox_count(&store), 120);
    let last = reports.last();
    assert_eq!(last.error, None);
    // 이어받기에서 새로 받은 수는 첫 시도에서 받은 만큼 줄어 있다.
    assert!(
        last.total < 90 + 12 + 10,
        "이미 받은 메일을 다시 받지 않는다"
    );
    assert!(after_first >= 30);
}

#[tokio::test]
async fn 받을_게_없으면_완료_알림_하나만_보낸다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;

    let reports = sync_all(&store, &fake).await;

    let all = reports.0.borrow();
    assert_eq!(all.len(), 1);
    assert_eq!(
        (all[0].done, all[0].total, all[0].error.clone()),
        (0, 0, None)
    );
}

#[tokio::test]
async fn 새_메일이_도착하면_받은편지함만_맞춰도_받는다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    fake.deliver("inbox", "새 메일이에요");

    let keys = vec!["inbox".to_string()];
    sync_account(&store, &fake, "n1", Scope::Folders(&keys), |_| {})
        .await
        .unwrap();

    let mails = store.list_mails(Some("n1"), "n1-inbox").unwrap();
    assert_eq!(mails.len(), 6);
    assert_eq!(mails[0].subject, "새 메일이에요");
    assert!(mails[0].unread);
}

#[tokio::test]
async fn 서버에서_지운_메일은_로컬에서도_사라진다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    fake.remove("inbox", "2");

    sync_all(&store, &fake).await;

    let mails = store.list_mails(Some("n1"), "n1-inbox").unwrap();
    assert_eq!(mails.len(), 4);
    assert!(mails.iter().all(|m| m.id != "n1-inbox-2"));
    assert!(store.get_mail("n1-inbox-2").unwrap().is_none());
}

#[tokio::test]
async fn 서버에서_바뀐_읽음_표시가_반영된다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    // 가짜 서버에서 0번은 안 읽음, 1번은 읽음
    assert!(
        store
            .get_mail("n1-inbox-0")
            .unwrap()
            .unwrap()
            .summary
            .unread
    );
    fake.set_unread("inbox", "0", false);
    fake.set_unread("inbox", "1", true);

    sync_all(&store, &fake).await;

    assert!(
        !store
            .get_mail("n1-inbox-0")
            .unwrap()
            .unwrap()
            .summary
            .unread
    );
    assert!(
        store
            .get_mail("n1-inbox-1")
            .unwrap()
            .unwrap()
            .summary
            .unread
    );
}

#[tokio::test]
async fn uid가_새로_매겨지면_폴더를_비우고_다시_받는다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    fake.renumber("inbox");

    sync_all(&store, &fake).await;

    let mails = store.list_mails(Some("n1"), "n1-inbox").unwrap();
    assert_eq!(mails.len(), 5);
    assert!(mails.iter().all(|m| m.id.starts_with("n1-inbox-10")));
}

#[tokio::test]
async fn 서버에서_사라진_폴더는_메일과_함께_지운다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    assert!(store.list_folders("n1").unwrap().len() > 5);

    // 다른 이름의 계정(폴더가 적은 서버)으로 같은 계정을 맞춘다.
    let smaller = FakeProvider::new(NOW, 5, 1);
    sync_account(&store, &smaller, "n1", Scope::All, |_| {})
        .await
        .unwrap();

    let folders = store.list_folders("n1").unwrap();
    assert_eq!(folders.len(), 5);
    assert!(store
        .list_mails(Some("n1"), "n1-l-travel")
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn 읽음_표시는_로컬에_바로_반영되고_서버에도_보낸다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;

    let account = actions::set_read(&store, "n1-inbox-0", true).unwrap();
    assert_eq!(account, "n1");
    assert!(
        !store
            .get_mail("n1-inbox-0")
            .unwrap()
            .unwrap()
            .summary
            .unread
    );

    flush_pending(&store, &fake, "n1").await.unwrap();

    assert!(fake.ops().contains(&"seen:inbox:0:true".to_string()));
    assert!(store.pending_ops("n1").unwrap().is_empty());
    // 서버도 읽음이므로 다음 동기화에서 되돌아가지 않는다.
    sync_all(&store, &fake).await;
    assert!(
        !store
            .get_mail("n1-inbox-0")
            .unwrap()
            .unwrap()
            .summary
            .unread
    );
}

#[tokio::test]
async fn 별표도_같은_방식으로_반영된다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;

    actions::set_starred(&store, "n1-inbox-1", true).unwrap();
    flush_pending(&store, &fake, "n1").await.unwrap();
    sync_all(&store, &fake).await;

    assert!(
        store
            .get_mail("n1-inbox-1")
            .unwrap()
            .unwrap()
            .summary
            .starred
    );
    assert!(fake.ops().contains(&"flagged:inbox:1:true".to_string()));
}

#[tokio::test]
async fn 같은_메일의_읽음_조작은_마지막_것만_큐에_남는다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;

    actions::set_read(&store, "n1-inbox-0", true).unwrap();
    actions::set_read(&store, "n1-inbox-0", false).unwrap();

    let ops = store.pending_ops("n1").unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].arg, "0");
}

#[tokio::test]
async fn 오프라인에서_한_조작은_큐에_남았다가_연결되면_순서대로_반영된다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    fake.set_offline(true);

    actions::set_read(&store, "n1-inbox-0", true).unwrap();
    actions::delete_mail(&store, "n1-inbox-3").unwrap();
    let err = flush_pending(&store, &fake, "n1").await.unwrap_err();
    assert!(matches!(
        err,
        SyncError::Provider(ProviderError::Network(_))
    ));
    assert_eq!(store.pending_ops("n1").unwrap().len(), 2);
    // 화면은 이미 바뀌어 있다.
    assert!(
        !store
            .get_mail("n1-inbox-0")
            .unwrap()
            .unwrap()
            .summary
            .unread
    );
    assert!(store.get_mail("n1-inbox-3").unwrap().is_none());

    fake.set_offline(false);
    sync_all(&store, &fake).await;

    assert!(store.pending_ops("n1").unwrap().is_empty());
    let ops = fake.ops();
    let seen = ops.iter().position(|o| o == "seen:inbox:0:true").unwrap();
    let moved = ops.iter().position(|o| o == "move:inbox:3:trash").unwrap();
    assert!(seen < moved);
    assert!(
        !store
            .get_mail("n1-inbox-0")
            .unwrap()
            .unwrap()
            .summary
            .unread
    );
}

#[tokio::test]
async fn 삭제하면_휴지통으로_옮기고_휴지통에서_삭제하면_완전히_지운다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    let trash_before = store.list_mails(Some("n1"), "n1-trash").unwrap().len();

    actions::delete_mail(&store, "n1-inbox-4").unwrap();
    assert_eq!(inbox_count(&store), 4);
    let moved = flush_pending(&store, &fake, "n1").await.unwrap();
    assert_eq!(moved, ["trash"]);
    sync_account(&store, &fake, "n1", Scope::Folders(&moved), |_| {})
        .await
        .unwrap();
    let trash = store.list_mails(Some("n1"), "n1-trash").unwrap();
    assert_eq!(trash.len(), trash_before + 1);

    // 휴지통 안의 메일을 지우면 서버에서 완전히 사라진다.
    actions::delete_mail(&store, &trash[0].id).unwrap();
    flush_pending(&store, &fake, "n1").await.unwrap();
    assert!(fake.ops().iter().any(|o| o.starts_with("delete:trash:")));
    sync_all(&store, &fake).await;
    assert_eq!(
        store.list_mails(Some("n1"), "n1-trash").unwrap().len(),
        trash_before
    );
}

#[tokio::test]
async fn 폴더_이동은_서버에서_새_번호로_다시_나타난다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    let before = store.list_mails(Some("n1"), "n1-l-family").unwrap().len();

    actions::move_mail(&store, "n1-inbox-1", "n1-l-family").unwrap();
    assert_eq!(inbox_count(&store), 4);
    let moved = flush_pending(&store, &fake, "n1").await.unwrap();
    assert_eq!(moved, ["l-family"]);
    sync_all(&store, &fake).await;

    assert_eq!(inbox_count(&store), 4);
    assert_eq!(
        store.list_mails(Some("n1"), "n1-l-family").unwrap().len(),
        before + 1
    );
}

#[tokio::test]
async fn 보관_폴더가_없으면_한_번만_만들고_그리로_옮긴다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    assert!(store.folder_of_kind("n1", "archive").unwrap().is_none());

    actions::archive_mail(&store, Some(&fake), "n1-inbox-1")
        .await
        .unwrap();
    assert_eq!(inbox_count(&store), 4);
    let (archive_id, key) = store.folder_of_kind("n1", "archive").unwrap().unwrap();
    assert_eq!(key, "보관함");
    flush_pending(&store, &fake, "n1").await.unwrap();
    sync_all(&store, &fake).await;
    assert_eq!(store.list_mails(Some("n1"), &archive_id).unwrap().len(), 1);

    actions::archive_mail(&store, Some(&fake), "n1-inbox-2")
        .await
        .unwrap();
    let creates = fake
        .ops()
        .iter()
        .filter(|o| o.starts_with("create:"))
        .count();
    assert_eq!(creates, 1);
}

#[tokio::test]
async fn gmail처럼_전체보관함이_있으면_만들지_않고_그리로_옮긴다() {
    let store = Store::open_in_memory().unwrap();
    let fake = FakeProvider::new(NOW, 5, 0);
    fake.add_folder("all", "전체보관함", FolderKind::All);
    add_account(
        &store,
        &MemoryStore::default(),
        &fake,
        new_account("n1", "a@gmail.com"),
        "pw",
    )
    .await
    .unwrap();
    sync_all(&store, &fake).await;

    actions::archive_mail(&store, None, "n1-inbox-1")
        .await
        .unwrap();
    let moved = flush_pending(&store, &fake, "n1").await.unwrap();

    assert_eq!(moved, ["all"]);
    assert!(!fake.ops().iter().any(|o| o.starts_with("create:")));
}

#[tokio::test]
async fn 이미_보관된_메일이나_휴지통_스팸_메일은_보관할_수_없다() {
    let (store, fake) = added(3).await;
    sync_all(&store, &fake).await;
    actions::archive_mail(&store, Some(&fake), "n1-inbox-0")
        .await
        .unwrap();
    let (archive_id, _) = store.folder_of_kind("n1", "archive").unwrap().unwrap();
    flush_pending(&store, &fake, "n1").await.unwrap();
    sync_all(&store, &fake).await;

    let archived = store.list_mails(Some("n1"), &archive_id).unwrap();
    assert!(matches!(
        actions::archive_mail(&store, Some(&fake), &archived[0].id).await,
        Err(SyncError::AlreadyArchived)
    ));
    let trash = store.list_mails(Some("n1"), "n1-trash").unwrap();
    assert!(matches!(
        actions::archive_mail(&store, Some(&fake), &trash[0].id).await,
        Err(SyncError::AlreadyArchived)
    ));
    let spam = store.list_mails(Some("n1"), "n1-spam").unwrap();
    assert!(matches!(
        actions::archive_mail(&store, Some(&fake), &spam[0].id).await,
        Err(SyncError::AlreadyArchived)
    ));
}

#[tokio::test]
async fn 보관_폴더를_만들_수_없는_서비스는_안내_오류를_낸다() {
    let (store, fake) = added(3).await;
    sync_all(&store, &fake).await;

    assert!(matches!(
        actions::archive_mail(&store, None, "n1-inbox-0").await,
        Err(SyncError::NotConnected)
    ));
    assert!(store.get_mail("n1-inbox-0").unwrap().is_some());
}

#[tokio::test]
async fn 서버가_거절한_조작은_버리고_큐를_막지_않는다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    actions::set_read(&store, "n1-inbox-0", true).unwrap();
    actions::set_read(&store, "n1-inbox-1", false).unwrap();
    // 다른 기기에서 0번을 지웠다.
    fake.remove("inbox", "0");

    flush_pending(&store, &fake, "n1").await.unwrap();

    assert!(store.pending_ops("n1").unwrap().is_empty());
    assert!(fake.ops().contains(&"seen:inbox:1:false".to_string()));
}

#[tokio::test]
async fn 없는_메일이나_폴더로의_조작은_오류다() {
    let (store, fake) = added(3).await;
    sync_all(&store, &fake).await;

    assert!(matches!(
        actions::set_read(&store, "nope", true),
        Err(SyncError::MailNotFound)
    ));
    assert!(matches!(
        actions::move_mail(&store, "n1-inbox-0", "n1-없는폴더"),
        Err(SyncError::FolderNotFound)
    ));
    assert!(matches!(
        actions::move_mail(&store, "n1-inbox-0", "other-inbox"),
        Err(SyncError::FolderNotFound)
    ));
    assert!(store.get_mail("n1-inbox-0").unwrap().is_some());
}

#[tokio::test]
async fn 아직_서버에_못_보낸_조작이_걸린_메일은_동기화가_덮어쓰지_않는다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    // 동기화 직전에 읽음으로 바꿨지만 큐는 아직 비우지 못한 상황을 만든다.
    actions::set_read(&store, "n1-inbox-0", true).unwrap();

    let plan = plan_folder(&store, &fake, "n1", "n1-inbox").await.unwrap();

    assert!(plan.missing.is_empty());
    assert!(
        !store
            .get_mail("n1-inbox-0")
            .unwrap()
            .unwrap()
            .summary
            .unread
    );
}

#[tokio::test]
async fn 지우는_중인_메일은_동기화가_다시_받지_않는다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    // 서버는 아직 옮기기 전인데 로컬에서는 이미 지운 상황 (이동 조작은 큐에 있다).
    actions::delete_mail(&store, "n1-inbox-4").unwrap();

    let plan = plan_folder(&store, &fake, "n1", "n1-inbox").await.unwrap();

    assert!(plan.missing.is_empty());
    assert_eq!(inbox_count(&store), 4);
}

#[tokio::test]
async fn 푸시를_못_쓰는_서버는_unsupported로_알려_준다() {
    let failing = Failing { verify: None };
    let err = failing
        .wait_for_changes("INBOX", Duration::from_secs(1), None)
        .await
        .unwrap_err();
    assert!(matches!(err, ProviderError::Unsupported(_)));
}

#[tokio::test]
async fn 휴지통과_스팸함은_한_번의_조작으로_비워진다() {
    for kind in ["trash", "spam"] {
        let (store, fake) = added(5).await;
        sync_all(&store, &fake).await;
        let folder_id = format!("n1-{kind}");
        assert!(!store.list_mails(Some("n1"), &folder_id).unwrap().is_empty());

        actions::empty_folder(&store, "n1", &folder_id).unwrap();
        // 로컬은 바로 비고 서버 조작은 한 건만 쌓인다.
        assert!(store.list_mails(Some("n1"), &folder_id).unwrap().is_empty());
        assert_eq!(store.pending_ops("n1").unwrap().len(), 1);

        flush_pending(&store, &fake, "n1").await.unwrap();
        assert_eq!(
            fake.ops()
                .iter()
                .filter(|o| o.starts_with("empty:"))
                .count(),
            1
        );
        sync_all(&store, &fake).await;
        assert!(store.list_mails(Some("n1"), &folder_id).unwrap().is_empty());
    }
}

#[tokio::test]
async fn 휴지통과_스팸이_아닌_폴더는_비우기를_거절한다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    let before = inbox_count(&store);

    for folder_id in ["n1-inbox", "n1-sent", "n1-drafts", "n1-l-family"] {
        let err = actions::empty_folder(&store, "n1", folder_id).unwrap_err();
        assert!(matches!(err, SyncError::NotEmptiable), "{folder_id}");
    }
    let err = actions::empty_folder(&store, "n1", "n1-없는폴더").unwrap_err();
    assert!(matches!(err, SyncError::FolderNotFound));
    // 다른 계정의 폴더 id로는 비울 수 없다.
    let err = actions::empty_folder(&store, "n2", "n1-trash").unwrap_err();
    assert!(matches!(err, SyncError::FolderNotFound));

    assert_eq!(inbox_count(&store), before);
    assert!(store.pending_ops("n1").unwrap().is_empty());
}

#[tokio::test]
async fn 오프라인에서_비운_폴더는_큐에_남았다가_연결되면_지워진다() {
    let (store, fake) = added(5).await;
    sync_all(&store, &fake).await;
    fake.set_offline(true);

    actions::empty_folder(&store, "n1", "n1-trash").unwrap();
    assert!(flush_pending(&store, &fake, "n1").await.is_err());
    assert_eq!(store.pending_ops("n1").unwrap().len(), 1);

    fake.set_offline(false);
    sync_all(&store, &fake).await;
    assert!(store.pending_ops("n1").unwrap().is_empty());
    assert!(fake.ops().iter().any(|o| o == "empty:trash"));
    assert!(store.list_mails(Some("n1"), "n1-trash").unwrap().is_empty());
}
