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

fn html_message(body: &str, html: Option<&str>) -> crate::providers::RemoteMessage {
    use crate::providers::{RemoteInlineImage, RemoteMessage};
    RemoteMessage {
        remote_id: "9".into(),
        thread_id: None,
        dedupe_key: None,
        sender: "뉴스레터".into(),
        sender_email: "news@example.com".into(),
        recipients: "me@naver.com".into(),
        subject: "소식".into(),
        body: body.into(),
        html: html.map(String::from),
        received_at: 1_760_000_000,
        unread: true,
        starred: false,
        label: None,
        attachments: Vec::new(),
        inline_images: vec![RemoteInlineImage {
            content_id: "Logo@Mail".into(),
            mime: "image/png".into(),
            data: b"Hello".to_vec(),
        }],
    }
}

#[tokio::test]
async fn html_본문을_텍스트와_별도로_보관하고_cid를_data_uri로_바꾼다() {
    let store = seeded().await;
    let html =
        r#"<p>로고</p><img src="cid:logo@mail"><IMG SRC='CID:LOGO@MAIL'><img src="cid:없음">"#;
    store
        .save_messages("a1", "inbox", &[html_message("로고", Some(html))])
        .unwrap();

    let detail = store.get_mail("a1-inbox-9").unwrap().unwrap();
    assert_eq!(detail.body, vec!["로고"]);
    let out = detail.html.unwrap();
    // "Hello"의 base64
    assert_eq!(out.matches("data:image/png;base64,SGVsbG8=").count(), 2);
    assert!(out.contains("cid:없음"));
    assert!(out.contains("<IMG SRC="), "원문 구조는 건드리지 않는다");

    // 텍스트 메일은 html이 없다
    assert!(store
        .get_mail("a1-inbox-0")
        .unwrap()
        .unwrap()
        .html
        .is_none());
}

#[tokio::test]
async fn 다시_동기화하면_본문과_html을_서버_값으로_갱신한다() {
    let store = seeded().await;
    store
        .save_messages(
            "a1",
            "inbox",
            &[html_message("<!--[if mso]> 깨진 본문", None)],
        )
        .unwrap();
    store
        .save_messages(
            "a1",
            "inbox",
            &[html_message("깨끗한 본문", Some("<p>HTML</p>"))],
        )
        .unwrap();

    let detail = store.get_mail("a1-inbox-9").unwrap().unwrap();
    assert_eq!(detail.body, vec!["깨끗한 본문"]);
    assert_eq!(detail.html.as_deref(), Some("<p>HTML</p>"));
    let preview: String = store
        .lock()
        .unwrap()
        .query_row(
            "SELECT preview FROM messages WHERE id = 'a1-inbox-9'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(preview, "깨끗한 본문");
    assert_eq!(store.search_mails("a1", "깨끗한").unwrap().len(), 1);
    assert!(store.search_mails("a1", "깨진").unwrap().is_empty());
}

#[tokio::test]
async fn 같은_dedupe_key_메일은_폴더가_달라도_한_번만_저장한다() {
    let store = seeded().await;
    let mut m = html_message("본문", None);
    m.dedupe_key = Some("1700000000000002".into());
    // 라벨 폴더가 먼저, 전체보관함이 나중에 동기화된다.
    store.save_messages("a1", "inbox", &[m.clone()]).unwrap();
    store.save_messages("a1", "trash", &[m.clone()]).unwrap();
    // 같은 폴더를 다시 동기화하는 건 갱신이다.
    store.save_messages("a1", "inbox", &[m]).unwrap();

    let count: i64 = store
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE dedupe_key = '1700000000000002'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let folder: String = store
        .lock()
        .unwrap()
        .query_row(
            "SELECT folder_id FROM messages WHERE dedupe_key = '1700000000000002'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(folder, "a1-inbox");
}

#[tokio::test]
async fn 차지한_메일이_사라지면_다른_폴더의_중복_사본을_다시_받을_수_있게_푼다() {
    let store = seeded().await;
    let mut m = html_message("본문", None);
    m.remote_id = "900".into();
    m.dedupe_key = Some("77".into());
    store.save_messages("a1", "inbox", &[m.clone()]).unwrap();
    // 전체보관함 역할의 폴더는 같은 메일을 건너뛰지만, 받았다는 기록은 남는다.
    let mut copy = m.clone();
    copy.remote_id = "5".into();
    store.save_messages("a1", "trash", &[copy]).unwrap();
    assert!(store.known_uids("a1-trash").unwrap().contains("5"));
    assert!(store.get_mail("a1-trash-5").unwrap().is_none());

    store
        .remove_remote("a1", "a1-inbox", &["900".to_string()])
        .unwrap();

    assert!(!store.known_uids("a1-inbox").unwrap().contains("900"));
    assert!(!store.known_uids("a1-trash").unwrap().contains("5"));
}

#[tokio::test]
async fn 건너뛴_중복_사본을_지워도_차지한_메일은_남는다() {
    let store = seeded().await;
    let mut m = html_message("본문", None);
    m.remote_id = "900".into();
    m.dedupe_key = Some("77".into());
    store.save_messages("a1", "inbox", &[m.clone()]).unwrap();
    let mut copy = m;
    copy.remote_id = "5".into();
    store.save_messages("a1", "trash", &[copy]).unwrap();

    store
        .remove_remote("a1", "a1-trash", &["5".to_string()])
        .unwrap();

    assert!(store.get_mail("a1-inbox-900").unwrap().is_some());
    assert!(store.known_uids("a1-inbox").unwrap().contains("900"));
}

#[test]
fn 이미_저장된_메일의_uid_기록은_마이그레이션이_채운다() {
    let dir = std::env::temp_dir().join(format!("mymail-test-uids-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("db.sqlite");
    {
        // 0003까지만 적용된 옛 DB를 만든다.
        let conn = Connection::open(&path).unwrap();
        for sql in &MIGRATIONS[..3] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 3).unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (id, name, email, provider, color_index, initial)
               VALUES ('a1', 'n', 'e@x.com', 'gmail', 1, 'n');
             INSERT INTO folders (id, account_id, name, kind) VALUES ('a1-INBOX', 'a1', 'INBOX', 'inbox');
             INSERT INTO messages (id, account_id, folder_id, sender, sender_email, subject, received_at)
               VALUES ('a1-INBOX-42', 'a1', 'a1-INBOX', 's', 's@x.com', '제목', 1);",
        )
        .unwrap();
    }

    let store = Store::open(&path).unwrap();
    assert!(store.known_uids("a1-INBOX").unwrap().contains("42"));
    drop(store);
    std::fs::remove_dir_all(&dir).unwrap();
}
