use std::cell::Cell;

use super::*;
use crate::auth::memory::MemoryStore;
use crate::providers::fake::{attachment_bytes, FakeProvider};
use crate::store::NewAccount;
use crate::sync::add_account;

const NOW: i64 = 1_760_000_000;

/// 첨부가 있는 메일 id와 첨부 id 목록
async fn setup() -> (Store, FakeProvider, String, Vec<i64>) {
    let store = Store::open_in_memory().unwrap();
    let fake = FakeProvider::new(NOW, 10, 0);
    add_account(
        &store,
        &MemoryStore::default(),
        &fake,
        NewAccount {
            id: "n1".into(),
            name: "a".into(),
            email: "a@naver.com".into(),
            provider: "naver".into(),
            color_index: 1,
        },
        "pw",
    )
    .await
    .unwrap();
    let mail = store
        .list_mails(Some("n1"), "n1-inbox")
        .unwrap()
        .into_iter()
        .find(|m| m.has_attachment)
        .unwrap();
    let ids = store
        .get_mail(&mail.id)
        .unwrap()
        .unwrap()
        .attachments
        .iter()
        .map(|a| a.id)
        .collect();
    (store, fake, mail.id, ids)
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mymail-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn 위험한_파일_이름을_정리한다() {
    assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
    assert_eq!(sanitize_file_name("C:\\Windows\\a.exe"), "a.exe");
    assert_eq!(sanitize_file_name("a<b>:c|d?.txt"), "a_b__c_d_.txt");
    assert_eq!(sanitize_file_name("보고서\u{0}\n.pdf"), "보고서__.pdf");
    assert_eq!(sanitize_file_name("끝에점과공백. . "), "끝에점과공백");
    assert_eq!(sanitize_file_name(".."), FALLBACK_NAME);
    assert_eq!(sanitize_file_name("   "), FALLBACK_NAME);
    assert_eq!(sanitize_file_name("CON"), "_CON");
    assert_eq!(sanitize_file_name("nul.txt"), "_nul.txt");
    assert_eq!(sanitize_file_name("com1.pdf"), "_com1.pdf");
    assert_eq!(sanitize_file_name("COM0.pdf"), "COM0.pdf");
    assert_eq!(sanitize_file_name("console.txt"), "console.txt");
}

#[test]
fn 너무_긴_이름은_확장자를_남기고_줄인다() {
    let long = format!("{}.pdf", "가".repeat(300));
    let out = sanitize_file_name(&long);
    assert!(out.chars().count() <= MAX_NAME_CHARS);
    assert!(out.ends_with(".pdf"));
}

#[test]
fn 이름이_겹치면_번호를_붙인다() {
    let dir = temp_dir("unique");
    assert_eq!(unique_path(&dir, "a.pdf"), dir.join("a.pdf"));
    std::fs::write(dir.join("a.pdf"), b"x").unwrap();
    assert_eq!(unique_path(&dir, "a.pdf"), dir.join("a (1).pdf"));
    std::fs::write(dir.join("a (1).pdf"), b"x").unwrap();
    assert_eq!(unique_path(&dir, "a.pdf"), dir.join("a (2).pdf"));
    std::fs::write(dir.join("noext"), b"x").unwrap();
    assert_eq!(unique_path(&dir, "noext"), dir.join("noext (1)"));
}

#[tokio::test]
async fn 첨부를_받아_고른_경로에_쓴다() {
    let (store, fake, mail_id, ids) = setup().await;
    let dir = temp_dir("one");
    let target = dir.join("내가_고른_이름.pdf");
    let default_name = Cell::new(String::new());
    let (outcome, path) = save_one(&store, &fake, &mail_id, ids[0], |name| {
        default_name.set(name.to_string());
        Some(target.clone())
    })
    .await
    .unwrap();
    assert_eq!(outcome, SaveOutcome::Saved { count: 1 });
    assert_eq!(path.unwrap(), target);
    assert_eq!(default_name.take(), "제주여행_일정표.pdf");
    assert_eq!(
        std::fs::read(&target).unwrap(),
        attachment_bytes("제주여행_일정표.pdf", 0)
    );
}

#[tokio::test]
async fn 대화상자를_취소하면_아무것도_쓰지_않고_서버에도_가지_않는다() {
    let (store, fake, mail_id, ids) = setup().await;
    let before = fake.ops().len();
    let (outcome, path) = save_one(&store, &fake, &mail_id, ids[0], |_| None)
        .await
        .unwrap();
    assert_eq!(outcome, SaveOutcome::Cancelled);
    assert!(path.is_none());
    assert_eq!(fake.ops().len(), before);

    let (outcome, _) = save_all(&store, &fake, &mail_id, || None).await.unwrap();
    assert_eq!(outcome, SaveOutcome::Cancelled);
    assert_eq!(fake.ops().len(), before);
}

#[tokio::test]
async fn 첨부를_받아도_읽음_상태는_그대로다() {
    let (store, fake, mail_id, ids) = setup().await;
    let dir = temp_dir("seen");
    let before = fake.snapshot("inbox").await.unwrap().messages;
    save_one(&store, &fake, &mail_id, ids[1], |_| Some(dir.join("b.pdf")))
        .await
        .unwrap();
    let after = fake.snapshot("inbox").await.unwrap().messages;
    assert_eq!(before, after);
    assert!(fake.ops().iter().all(|op| !op.starts_with("seen:")));
}

#[tokio::test]
async fn 모두_저장하면_이름이_겹치는_파일에_번호가_붙는다() {
    let (store, fake, mail_id, ids) = setup().await;
    let dir = temp_dir("all");
    std::fs::write(dir.join("제주여행_일정표.pdf"), "기존".as_bytes()).unwrap();
    let (outcome, first) = save_all(&store, &fake, &mail_id, || Some(dir.clone()))
        .await
        .unwrap();
    assert_eq!(outcome, SaveOutcome::Saved { count: ids.len() });
    assert_eq!(first.unwrap(), dir.join("제주여행_일정표 (1).pdf"));
    // 기존 파일은 덮어쓰지 않는다.
    assert_eq!(
        std::fs::read(dir.join("제주여행_일정표.pdf")).unwrap(),
        "기존".as_bytes()
    );
    assert_eq!(
        std::fs::read(dir.join("숙소_외관.jpg")).unwrap(),
        attachment_bytes("숙소_외관.jpg", 2)
    );
    // 첨부 전체가 서버에서 내려왔다.
    let fetches = fake
        .ops()
        .iter()
        .filter(|op| op.starts_with("attachment:"))
        .count();
    assert_eq!(fetches, ids.len());
}

#[tokio::test]
async fn 없는_첨부와_오프라인은_한국어_안내가_된다() {
    let (store, fake, mail_id, ids) = setup().await;
    let err = save_one(&store, &fake, &mail_id, 9999, |_| None)
        .await
        .unwrap_err();
    assert!(matches!(err, AttachmentError::NotFound));

    fake.set_offline(true);
    let dir = temp_dir("offline");
    let err = save_one(&store, &fake, &mail_id, ids[0], |_| Some(dir.join("a.pdf")))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "network");
    assert!(err.user_message().contains("연결"));
    assert!(!dir.join("a.pdf").exists());
}
