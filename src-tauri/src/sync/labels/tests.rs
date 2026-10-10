use super::*;
use crate::auth::memory::MemoryStore;
use crate::providers::fake::FakeProvider;
use crate::providers::ProviderError;
use crate::store::NewAccount;
use crate::sync::{
    add_account, flush_pending, sync_account, sync_account_with, Scope, SyncOptions,
};

const NOW: i64 = 1_760_000_000;

/// 라벨이 있는 가짜 서버(가족·여행·금융)에 계정 `n1`을 추가하고 모든 폴더를 받은 상태
async fn setup() -> (Store, FakeProvider) {
    let store = Store::open_in_memory().unwrap();
    let fake = FakeProvider::new(NOW, 8, 0);
    add_account(
        &store,
        &MemoryStore::default(),
        &fake,
        NewAccount {
            id: "n1".into(),
            name: "a@gmail.com".into(),
            email: "a@gmail.com".into(),
            provider: "gmail".into(),
            color_index: 1,
        },
        "pw",
    )
    .await
    .unwrap();
    sync_account(&store, &fake, "n1", Scope::All, |_| {})
        .await
        .unwrap();
    (store, fake)
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_string()).collect()
}

fn labels_of(store: &Store, id: &str) -> Vec<String> {
    store.mail_labels(id).unwrap().unwrap()
}

#[tokio::test]
async fn 라벨_붙이기는_로컬에_먼저_반영되고_큐를_거쳐_서버에_간다() {
    let (store, fake) = setup().await;
    assert_eq!(labels_of(&store, "n1-inbox-1"), Vec::<String>::new());

    change_labels(&store, &fake, &ids(&["n1-inbox-1"]), "가족", true).unwrap();

    assert_eq!(labels_of(&store, "n1-inbox-1"), vec!["가족"]);
    let ops = store.pending_ops("n1").unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].kind, OpKind::AddLabel);
    assert_eq!(ops[0].arg, "가족");

    flush_pending(&store, &fake, "n1").await.unwrap();
    assert!(store.pending_ops("n1").unwrap().is_empty());
    assert!(fake.ops().contains(&"add_label:inbox:1:가족".to_string()));
}

#[tokio::test]
async fn 라벨_떼기와_여러_메일_일괄_처리() {
    let (store, fake) = setup().await;
    // inbox 0, 3은 서버에서 이미 "여행"이 붙어 있다.
    assert_eq!(labels_of(&store, "n1-inbox-0"), vec!["여행"]);

    change_labels(
        &store,
        &fake,
        &ids(&["n1-inbox-1", "n1-inbox-2"]),
        "가족",
        true,
    )
    .unwrap();
    assert_eq!(store.pending_ops("n1").unwrap().len(), 2);
    change_labels(
        &store,
        &fake,
        &ids(&["n1-inbox-0", "n1-inbox-3"]),
        "여행",
        false,
    )
    .unwrap();
    assert!(labels_of(&store, "n1-inbox-0").is_empty());
    assert!(labels_of(&store, "n1-inbox-3").is_empty());

    flush_pending(&store, &fake, "n1").await.unwrap();
    let ops = fake.ops();
    assert!(ops.contains(&"add_label:inbox:2:가족".to_string()));
    assert!(ops.contains(&"remove_label:inbox:3:여행".to_string()));
}

#[tokio::test]
async fn 이미_붙은_라벨은_다시_붙이지_않는다() {
    let (store, fake) = setup().await;
    change_labels(&store, &fake, &ids(&["n1-inbox-0"]), "여행", true).unwrap();
    assert!(store.pending_ops("n1").unwrap().is_empty());
    change_labels(&store, &fake, &ids(&["n1-inbox-1"]), "여행", false).unwrap();
    assert!(store.pending_ops("n1").unwrap().is_empty());
}

#[tokio::test]
async fn 붙인_라벨은_라벨_폴더의_목록과_안_읽은_수에_나타난다() {
    let (store, fake) = setup().await;
    let unread = |store: &Store| {
        store
            .list_folders("n1")
            .unwrap()
            .into_iter()
            .find(|f| f.id == "n1-l-family")
            .unwrap()
            .unread
    };
    let before = unread(&store);
    let before_count = store.list_mails(Some("n1"), "n1-l-family").unwrap().len();
    // inbox 4는 안 읽음(4의 배수)이다.
    change_labels(
        &store,
        &fake,
        &ids(&["n1-inbox-4", "n1-inbox-1"]),
        "가족",
        true,
    )
    .unwrap();

    assert_eq!(unread(&store), before + 1);
    let mails = store.list_mails(Some("n1"), "n1-l-family").unwrap();
    assert_eq!(mails.len(), before_count + 2);
    assert!(mails.iter().any(|m| m.id == "n1-inbox-4"));

    // 떼면 사라진다.
    change_labels(&store, &fake, &ids(&["n1-inbox-4"]), "가족", false).unwrap();
    assert_eq!(unread(&store), before);
    let mails = store.list_mails(Some("n1"), "n1-l-family").unwrap();
    assert!(!mails.iter().any(|m| m.id == "n1-inbox-4"));
}

#[tokio::test]
async fn 없는_라벨과_시스템_이름은_거절한다() {
    let (store, fake) = setup().await;
    let add = |name: &str| change_labels(&store, &fake, &ids(&["n1-inbox-1"]), name, true);
    assert!(matches!(add("없는라벨"), Err(SyncError::LabelNotFound)));
    assert!(matches!(add("INBOX"), Err(SyncError::InvalidLabel(_))));
    assert!(matches!(add("inbox/하위"), Err(SyncError::InvalidLabel(_))));
    assert!(matches!(
        add("[Gmail]/Sent Mail"),
        Err(SyncError::InvalidLabel(_))
    ));
    assert!(matches!(add("받은편지함"), Err(SyncError::InvalidLabel(_))));
    assert!(store.pending_ops("n1").unwrap().is_empty());
}

#[tokio::test]
async fn 하나라도_틀리면_아무것도_바꾸지_않는다() {
    let (store, fake) = setup().await;
    let err = change_labels(
        &store,
        &fake,
        &ids(&["n1-inbox-1", "n1-inbox-없음"]),
        "가족",
        true,
    );
    assert!(matches!(err, Err(SyncError::MailNotFound)));
    assert!(labels_of(&store, "n1-inbox-1").is_empty());
    assert!(store.pending_ops("n1").unwrap().is_empty());
}

#[test]
fn 라벨_이름_검증() {
    let store = Store::open_in_memory().unwrap();
    let ok = |s: &str| validate_label_name(&store, "n1", s);
    assert_eq!(ok("  여행/제주  ").unwrap(), "여행/제주");
    assert!(ok("").is_err());
    assert!(ok("   ").is_err());
    assert!(ok(&"가".repeat(MAX_LABEL_CHARS + 1)).is_err());
    assert!(ok(&"가".repeat(MAX_LABEL_CHARS)).is_ok());
    assert!(ok("a\\b").is_err());
    assert!(ok("a\"b").is_err());
    assert!(ok("a*b").is_err());
    assert!(ok("a\nb").is_err());
    assert!(ok("/a").is_err());
    assert!(ok("a/").is_err());
    assert!(ok("a//b").is_err());
    assert!(ok("a/ b").is_err());
    assert!(ok("INBOX").is_err());
    assert!(ok("Inbox/하위").is_err());
    assert!(ok("[Gmail]/Trash").is_err());
}

#[tokio::test]
async fn 라벨이_없는_서비스는_한국어_오류로_거절하고_큐에_넣지_않는다() {
    let (store, fake) = setup().await;
    fake.set_supports_labels(false);
    let err = change_labels(&store, &fake, &ids(&["n1-inbox-1"]), "가족", true).unwrap_err();
    assert!(matches!(err, SyncError::LabelsUnsupported));
    assert!(err.to_string().contains("지원하지 않아요"));
    assert!(store.pending_ops("n1").unwrap().is_empty());
    assert!(labels_of(&store, "n1-inbox-1").is_empty());

    assert!(matches!(
        create_label(&store, &fake, "n1", "새라벨").await,
        Err(SyncError::LabelsUnsupported)
    ));
    assert!(matches!(
        rename_label(&store, &fake, "n1", "n1-l-family", "친척").await,
        Err(SyncError::LabelsUnsupported)
    ));
    assert!(matches!(
        delete_label(&store, &fake, "n1", "n1-l-family").await,
        Err(SyncError::LabelsUnsupported)
    ));
}

#[tokio::test]
async fn 오프라인에서_붙인_라벨은_큐에_남았다가_연결되면_간다() {
    let (store, fake) = setup().await;
    fake.set_offline(true);
    change_labels(&store, &fake, &ids(&["n1-inbox-1"]), "가족", true).unwrap();
    change_labels(&store, &fake, &ids(&["n1-inbox-1"]), "가족", false).unwrap();

    let err = flush_pending(&store, &fake, "n1").await.unwrap_err();
    assert!(matches!(
        err,
        SyncError::Provider(ProviderError::Network(_))
    ));
    assert_eq!(store.pending_ops("n1").unwrap().len(), 2);

    fake.set_offline(false);
    flush_pending(&store, &fake, "n1").await.unwrap();
    assert!(store.pending_ops("n1").unwrap().is_empty());
    let ops = fake.ops();
    let add = ops
        .iter()
        .position(|o| o == "add_label:inbox:1:가족")
        .unwrap();
    let remove = ops
        .iter()
        .position(|o| o == "remove_label:inbox:1:가족")
        .unwrap();
    assert!(add < remove);
}

#[tokio::test]
async fn 서버가_거절한_라벨_조작은_로컬_표시를_되돌린다() {
    let (store, fake) = setup().await;
    change_labels(&store, &fake, &ids(&["n1-inbox-1"]), "가족", true).unwrap();
    // 그 사이 서버에서 메일이 사라졌다.
    fake.remove("inbox", "1");
    flush_pending(&store, &fake, "n1").await.unwrap();
    assert!(labels_of(&store, "n1-inbox-1").is_empty());
    assert!(store.pending_ops("n1").unwrap().is_empty());
}

#[tokio::test]
async fn 보내지_못한_라벨_조작이_있는_메일은_재동기화가_덮어쓰지_않는다() {
    let (store, fake) = setup().await;
    change_labels(&store, &fake, &ids(&["n1-inbox-1"]), "가족", true).unwrap();
    // 서버에는 아직 반영되지 않았다. 라벨까지 다시 읽는 동기화가 돌아도 로컬 표시가 남는다.
    sync_account_with(
        &store,
        &fake,
        "n1",
        Scope::All,
        SyncOptions {
            refresh_labels: true,
            ..SyncOptions::default()
        },
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(labels_of(&store, "n1-inbox-1"), vec!["가족"]);
}

#[tokio::test]
async fn 새_라벨을_만들면_폴더가_생기고_바로_붙일_수_있다() {
    let (store, fake) = setup().await;
    let id = create_label(&store, &fake, "n1", " 여행/제주 ")
        .await
        .unwrap();

    let folder = store
        .list_folders("n1")
        .unwrap()
        .into_iter()
        .find(|f| f.id == id)
        .unwrap();
    assert_eq!(folder.kind, "label");
    assert_eq!(folder.path, "여행/제주");
    assert_eq!(folder.name, "제주");
    assert!(fake.ops().contains(&"create_label:여행/제주".to_string()));

    change_labels(&store, &fake, &ids(&["n1-inbox-1"]), "여행/제주", true).unwrap();
    assert_eq!(labels_of(&store, "n1-inbox-1"), vec!["여행/제주"]);

    // 이미 있으면 다시 만들지 않고 같은 폴더를 돌려준다.
    let again = create_label(&store, &fake, "n1", "여행/제주")
        .await
        .unwrap();
    assert_eq!(again, id);
    assert_eq!(
        fake.ops()
            .iter()
            .filter(|o| o.starts_with("create_label:"))
            .count(),
        1
    );
    assert!(create_label(&store, &fake, "n1", "INBOX").await.is_err());
}

#[tokio::test]
async fn 오프라인에서_라벨을_만들면_실패하고_폴더가_생기지_않는다() {
    let (store, fake) = setup().await;
    fake.set_offline(true);
    assert!(create_label(&store, &fake, "n1", "새라벨").await.is_err());
    assert!(store.label_folder("n1", "새라벨").unwrap().is_none());
}

#[tokio::test]
async fn 이름을_바꾸면_메일의_라벨과_폴더가_함께_바뀐다() {
    let (store, fake) = setup().await;
    create_label(&store, &fake, "n1", "여행/제주")
        .await
        .unwrap();
    change_labels(&store, &fake, &ids(&["n1-inbox-1"]), "여행/제주", true).unwrap();
    assert_eq!(labels_of(&store, "n1-inbox-0"), vec!["여행"]);

    rename_label(&store, &fake, "n1", "n1-l-travel", "해외여행")
        .await
        .unwrap();

    assert_eq!(labels_of(&store, "n1-inbox-0"), vec!["해외여행"]);
    assert_eq!(labels_of(&store, "n1-inbox-1"), vec!["해외여행/제주"]);
    let folders = store.list_folders("n1").unwrap();
    let travel = folders.iter().find(|f| f.id == "n1-l-travel").unwrap();
    assert_eq!(travel.path, "해외여행");
    assert!(fake
        .ops()
        .contains(&"rename_label:여행:해외여행".to_string()));
    // 바뀐 이름으로 다시 붙일 수 있고, 옛 이름은 없다.
    assert!(store.label_folder("n1", "여행").unwrap().is_none());
    assert!(store.label_folder("n1", "해외여행").unwrap().is_some());
}

async fn rename_travel(store: &Store, fake: &FakeProvider, name: &str) -> Result<(), SyncError> {
    rename_label(store, fake, "n1", "n1-l-travel", name).await
}

#[tokio::test]
async fn 이름_바꾸기는_중복과_잘못된_이름을_거절한다() {
    let (store, fake) = setup().await;
    assert!(matches!(
        rename_travel(&store, &fake, "가족").await,
        Err(SyncError::InvalidLabel(_))
    ));
    assert!(matches!(
        rename_travel(&store, &fake, "").await,
        Err(SyncError::InvalidLabel(_))
    ));
    assert!(matches!(
        rename_travel(&store, &fake, "INBOX").await,
        Err(SyncError::InvalidLabel(_))
    ));
    assert!(matches!(
        rename_label(&store, &fake, "n1", "n1-inbox", "x").await,
        Err(SyncError::LabelNotFound)
    ));
    assert!(rename_travel(&store, &fake, "여행").await.is_ok());
    assert!(!fake.ops().iter().any(|o| o.starts_with("rename_label:")));
}

#[tokio::test]
async fn 라벨을_지워도_메일은_남고_라벨만_떨어진다() {
    let (store, fake) = setup().await;
    let inbox_before = store.list_mails(Some("n1"), "n1-inbox").unwrap().len();
    assert_eq!(labels_of(&store, "n1-inbox-0"), vec!["여행"]);

    delete_label(&store, &fake, "n1", "n1-l-travel")
        .await
        .unwrap();

    assert!(labels_of(&store, "n1-inbox-0").is_empty());
    assert!(store.label_folder("n1", "여행").unwrap().is_none());
    assert_eq!(
        store.list_mails(Some("n1"), "n1-inbox").unwrap().len(),
        inbox_before
    );
    assert!(fake.ops().contains(&"delete_label:여행".to_string()));
    // 서버의 메일도 남아 있다(라벨 폴더에 있던 메일은 받은편지함으로 이동했다).
    let server = fake.fetch_messages("inbox", 100).await.unwrap();
    assert!(server
        .iter()
        .all(|m| !m.labels.contains(&"여행".to_string())));
    assert!(server.len() >= inbox_before);
}
