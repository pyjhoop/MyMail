use super::*;
use crate::providers::fake::FakeProvider;
use crate::providers::MailProvider;

async fn seeded() -> Store {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_account(&NewAccount {
            id: "a1".into(),
            name: "개인 Gmail".into(),
            email: "me@gmail.com".into(),
            provider: "gmail".into(),
            color_index: 1,
        })
        .unwrap();
    let p = FakeProvider::new(1_760_000_000, 20, 0);
    store
        .save_folders("a1", &p.list_folders().await.unwrap())
        .unwrap();
    for f in p.list_folders().await.unwrap() {
        let msgs = p.fetch_messages(&f.key, 100).await.unwrap();
        store.save_messages("a1", &f.key, &msgs).unwrap();
    }
    store
}

#[test]
fn 마이그레이션은_여러_번_열어도_안전하다() {
    let dir = std::env::temp_dir().join(format!("mymail-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("db.sqlite");
    drop(Store::open(&path).unwrap());
    Store::open(&path).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn 계정과_폴더가_읽힌다() {
    let store = seeded().await;
    let accounts = store.list_accounts().unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].initial, "개");
    assert_eq!(accounts[0].unread, 5); // i % 4 == 0 → 0,4,8,12,16

    let folders = store.list_folders("a1").unwrap();
    assert_eq!(folders[0].id, "a1-inbox");
    assert_eq!(folders[0].unread, 5);
    assert!(folders
        .iter()
        .any(|f| f.name == "계약·서류" && f.depth == 1));
}

#[tokio::test]
async fn 메일_목록은_최신순이고_스레드_수를_센다() {
    let store = seeded().await;
    let mails = store.list_mails(Some("a1"), "a1-inbox").unwrap();
    assert_eq!(mails.len(), 20);
    assert!(mails
        .windows(2)
        .all(|w| w[0].received_at >= w[1].received_at));
    assert_eq!(mails[0].thread_count, Some(3));
    assert_eq!(mails[3].thread_count, None);
}

#[tokio::test]
async fn 통합_받은편지함은_받은편지함만_모은다() {
    let store = seeded().await;
    let all = store.list_mails(None, "").unwrap();
    assert_eq!(all.len(), 20);
    assert!(all.iter().all(|m| m.folder_id == "a1-inbox"));
}

#[tokio::test]
async fn 상세는_본문_첨부_이전메일을_담는다() {
    let store = seeded().await;
    let detail = store.get_mail("a1-inbox-0").unwrap().unwrap();
    assert!(detail.body.len() > 1);
    assert_eq!(detail.earlier.len(), 2);
    assert_eq!(detail.attachments.len(), 3);
    assert_eq!(detail.attachments[0].ext, "PDF");
    assert!(store.get_mail("없는-id").unwrap().is_none());
}

#[tokio::test]
async fn 한글_검색이_접두어로_동작한다() {
    let store = seeded().await;
    assert!(!store.search_mails("a1", "견적").unwrap().is_empty());
    assert!(!store.search_mails("a1", "토스").unwrap().is_empty());
    assert!(store.search_mails("a1", "\"").unwrap().is_empty());
    assert!(store
        .search_mails("a1", "존재하지않는단어")
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn 다시_저장해도_중복되지_않는다() {
    let store = seeded().await;
    let p = FakeProvider::new(1_760_000_000, 20, 0);
    store
        .save_messages(
            "a1",
            "inbox",
            &p.fetch_messages("inbox", 100).await.unwrap(),
        )
        .unwrap();
    assert_eq!(store.list_mails(Some("a1"), "a1-inbox").unwrap().len(), 20);
}
