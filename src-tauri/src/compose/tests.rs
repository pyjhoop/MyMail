use super::*;
use crate::providers::fake::FakeProvider;
use crate::store::{ComposeInput, NewAccount};

fn store_with_account(provider: &str) -> Store {
    let store = Store::open_in_memory().unwrap();
    store
        .insert_account(&NewAccount {
            id: "a1".into(),
            name: "박준호".into(),
            email: "me@gmail.com".into(),
            provider: provider.into(),
            color_index: 1,
        })
        .unwrap();
    store
}

fn input(id: &str) -> ComposeInput {
    ComposeInput {
        id: id.into(),
        account_id: "a1".into(),
        to: vec!["김도윤 <doyun@gmail.com>".into()],
        cc: vec![],
        bcc: vec![],
        subject: "안녕".into(),
        body: "본문".into(),
        quote_header: String::new(),
        quote_text: String::new(),
    }
}

#[tokio::test]
async fn 보내면_서버가_받고_작성_중인_메일은_지워진다() {
    let store = store_with_account("gmail");
    store.save_compose(&input("draft:1")).unwrap();
    store
        .add_compose_attachment("draft:1", "a.txt", "text/plain", b"hi")
        .unwrap();
    let provider = FakeProvider::new(1_760_000_000, 3, 0);

    send(&store, &provider, "draft:1").await.unwrap();

    let sent = provider.sent_mails();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].from_email, "me@gmail.com");
    assert_eq!(sent[0].to, ["김도윤 <doyun@gmail.com>"]);
    assert_eq!(sent[0].attachments[0].name, "a.txt");
    assert!(store.get_compose("draft:1").unwrap().is_none());
}

#[tokio::test]
async fn 연결이_없으면_실패로_남아_다시_보낼_수_있다() {
    let store = store_with_account("gmail");
    store.save_compose(&input("draft:1")).unwrap();
    let provider = FakeProvider::new(1_760_000_000, 3, 0);
    provider.set_offline(true);

    let err = send(&store, &provider, "draft:1").await.unwrap_err();
    assert!(matches!(
        err,
        ComposeError::Provider(ProviderError::Network(_))
    ));
    let kept = store.get_compose("draft:1").unwrap().unwrap();
    assert_eq!(kept.status, "failed");
    assert!(kept.error.is_some());

    provider.set_offline(false);
    send(&store, &provider, "draft:1").await.unwrap();
    assert_eq!(provider.sent_mails().len(), 1);
    assert!(store.get_compose("draft:1").unwrap().is_none());
}

#[tokio::test]
async fn 받는사람이_없거나_주소가_틀리면_보내지_않는다() {
    let store = store_with_account("gmail");
    let provider = FakeProvider::new(1_760_000_000, 3, 0);

    let mut empty = input("draft:1");
    empty.to.clear();
    store.save_compose(&empty).unwrap();
    assert!(matches!(
        send(&store, &provider, "draft:1").await,
        Err(ComposeError::NoRecipients)
    ));

    let mut bad = input("draft:2");
    bad.cc = vec!["not-an-address".into()];
    store.save_compose(&bad).unwrap();
    assert!(matches!(
        send(&store, &provider, "draft:2").await,
        Err(ComposeError::InvalidAddress(_))
    ));
    assert!(provider.sent_mails().is_empty());
    // 검증에 걸린 메일은 그대로 임시 상태다.
    assert_eq!(
        store.get_compose("draft:2").unwrap().unwrap().status,
        "draft"
    );
}

#[test]
fn 첨부는_서비스_한도의_3분의_4_역수까지만_받는다() {
    let store = store_with_account("naver"); // 20MB → 원본 15MB
    store.save_compose(&input("draft:1")).unwrap();
    let mb = |n: usize| vec![0u8; n * 1024 * 1024];

    add_attachment(&store, "draft:1", "a.bin", "", &mb(10)).unwrap();
    let err = add_attachment(&store, "draft:1", "b.bin", "", &mb(6)).unwrap_err();
    assert!(matches!(err, ComposeError::TooLarge { limit_mb: 20 }));
    // 거절한 첨부는 저장되지 않는다.
    assert_eq!(
        store
            .get_compose("draft:1")
            .unwrap()
            .unwrap()
            .attachments
            .len(),
        1
    );
    add_attachment(&store, "draft:1", "c.bin", "", &mb(5)).unwrap();
}

#[test]
fn 임시저장은_덮어쓰고_첨부를_지우면_함께_지워진다() {
    let store = store_with_account("gmail");
    store.save_compose(&input("draft:1")).unwrap();
    let id = add_attachment(&store, "draft:1", "a.txt", "text/plain", b"hi").unwrap();

    let mut edited = input("draft:1");
    edited.subject = "바뀐 제목".into();
    store.save_compose(&edited).unwrap();
    let mail = store.get_compose("draft:1").unwrap().unwrap();
    assert_eq!(mail.subject, "바뀐 제목");
    assert_eq!(mail.attachments.len(), 1, "본문을 저장해도 첨부는 유지된다");

    store.remove_compose_attachment("draft:1", id).unwrap();
    assert!(store
        .get_compose("draft:1")
        .unwrap()
        .unwrap()
        .attachments
        .is_empty());
    store.delete_compose("draft:1").unwrap();
    assert!(store.get_compose("draft:1").unwrap().is_none());
}

#[tokio::test]
async fn 임시보관함_목록에_작성_중인_메일이_섞여_나온다() {
    let store = store_with_account("gmail");
    let provider = FakeProvider::new(1_760_000_000, 3, 0);
    store
        .save_folders("a1", &provider.list_folders().await.unwrap())
        .unwrap();
    store.save_compose(&input("draft:1")).unwrap();
    store.set_compose_failed("draft:1", "연결 끊김").unwrap();

    let drafts = store.list_mails(Some("a1"), "a1-drafts").unwrap();
    let mine = drafts.iter().find(|m| m.id == "draft:1").unwrap();
    assert_eq!(mine.sender, "김도윤");
    assert_eq!(mine.label.as_ref().unwrap().name, "보내지 못함");
    // 다른 폴더에는 나타나지 않는다.
    let inbox = store.list_mails(Some("a1"), "a1-inbox").unwrap();
    assert!(inbox.iter().all(|m| m.id != "draft:1"));
}

#[tokio::test]
async fn 주소_자동완성은_받은_사람과_보낸_사람을_자주_오간_순으로_준다() {
    let store = store_with_account("gmail");
    let provider = FakeProvider::new(1_760_000_000, 20, 0);
    for f in provider.list_folders().await.unwrap() {
        let msgs = provider.fetch_messages(&f.key, 100).await.unwrap();
        store
            .save_folders("a1", &provider.list_folders().await.unwrap())
            .unwrap();
        store.save_messages("a1", &f.key, &msgs).unwrap();
    }
    let found = store.suggest_addresses("도윤").unwrap();
    assert_eq!(found[0].email, "doyun.kim@gmail.com");
    assert_eq!(found[0].name, "김도윤");
    assert!(store.suggest_addresses("").unwrap().is_empty());
    // LIKE 특수 문자는 문자 그대로 찾는다.
    assert!(store.suggest_addresses("%").unwrap().is_empty());
    // 내 계정 주소는 추천하지 않는다.
    assert!(store.suggest_addresses("me@gmail").unwrap().is_empty());
}

#[test]
fn 서명은_계정에_저장된다() {
    let store = store_with_account("gmail");
    store.set_signature("a1", "박준호 드림").unwrap();
    assert_eq!(store.list_accounts().unwrap()[0].signature, "박준호 드림");
}

#[test]
fn 계정_이름_색_순서_답장서명을_바꾼다() {
    let store = store_with_account("gmail");
    store
        .insert_account(&NewAccount {
            id: "a2".into(),
            name: "둘째".into(),
            email: "two@naver.com".into(),
            provider: "naver".into(),
            color_index: 2,
        })
        .unwrap();
    assert!(store.list_accounts().unwrap()[0].sign_replies);

    store.update_account_profile("a1", "회사 메일", 5).unwrap();
    store.set_sign_replies("a1", false).unwrap();
    let a1 = store.list_accounts().unwrap().remove(0);
    assert_eq!(a1.name, "회사 메일");
    assert_eq!(a1.color_index, 5);
    assert_eq!(a1.initial, "회");
    assert!(!a1.sign_replies);

    store.reorder_accounts(&["a2".to_string()]).unwrap();
    let ids: Vec<String> = store
        .list_accounts()
        .unwrap()
        .into_iter()
        .map(|a| a.id)
        .collect();
    assert_eq!(ids, ["a2", "a1"]);
}

#[test]
fn 인용은_보낼_때에만_머리말과_함께_붙는다() {
    let body = outgoing_body(
        "알겠어요\n\n-- \n서명",
        "2026년 10월 9일 오후 3:20, 김도윤 <d@g.com>님이 작성:",
        "안녕\n\n> 이전 글",
    );
    assert_eq!(
        body,
        "알겠어요\n\n-- \n서명\n\n2026년 10월 9일 오후 3:20, 김도윤 <d@g.com>님이 작성:\n> 안녕\n>\n> > 이전 글"
    );
    assert_eq!(outgoing_body("본문", "머리말", ""), "본문");
}

#[tokio::test]
async fn 임시저장한_인용은_분리되어_복원되고_발송_본문에만_붙는다() {
    let store = store_with_account("gmail");
    let mut mail = input("draft:q");
    mail.quote_header = "머리말:".into();
    mail.quote_text = "원문".into();
    store.save_compose(&mail).unwrap();

    let saved = store.get_compose("draft:q").unwrap().unwrap();
    assert_eq!(saved.body, "본문");
    assert_eq!(saved.quote_text, "원문");

    let provider = FakeProvider::new(1_760_000_000, 3, 0);
    send(&store, &provider, "draft:q").await.unwrap();
    assert_eq!(provider.sent_mails()[0].body, "본문\n\n머리말:\n> 원문");
}
