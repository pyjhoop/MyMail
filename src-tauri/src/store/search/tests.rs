use super::*;
use crate::providers::{RemoteFolder, RemoteMessage};
use crate::store::NewAccount;

const KST: i64 = 9 * 3600;

fn parse(s: &str) -> ParsedQuery {
    ParsedQuery::parse(s, KST)
}

#[test]
fn 연산자를_해석한다() {
    let q = parse("항공권 from:한결카드 to:me@x.com has:첨부 is:안읽음 is:별표 after:2026-09-01");
    assert_eq!(q.terms, vec!["항공권"]);
    assert_eq!(q.from, vec!["한결카드"]);
    assert_eq!(q.to, vec!["me@x.com"]);
    assert!(q.has_attachment && q.starred);
    assert_eq!(q.unread, Some(true));
    // 2026-09-01 00:00 KST = 2026-08-31 15:00 UTC
    assert_eq!(q.after, Some(1_788_188_400));
    assert_eq!(parse("is:읽음").unread, Some(false));
    assert_eq!(parse("before:1970-01-02").before, Some(86_400 - KST));
}

#[test]
fn 모르는_연산자와_잘못된_값은_일반_검색어다() {
    let q = parse("foo:bar has:없음 after:2026-13-40 after:abc from: is:");
    assert_eq!(
        q.terms,
        vec![
            "foo:bar",
            "has:없음",
            "after:2026-13-40",
            "after:abc",
            "from:",
            "is:"
        ]
    );
    assert!(q.from.is_empty() && q.after.is_none() && !q.has_attachment);
    assert!(parse("after:2025-02-29").after.is_none());
    assert!(parse("after:2024-02-29").after.is_some());
}

#[test]
fn 따옴표로_공백이_든_값을_묶는다() {
    let q = parse("from:\"한결 카드\" \"두 단어\"");
    assert_eq!(q.from, vec!["한결 카드"]);
    assert_eq!(q.terms, vec!["두 단어"]);
}

#[test]
fn 검색식은_바인딩되고_특수문자는_무해하다() {
    // FTS 연산자 글자(OR·AND·NEAR·괄호)가 들어가도 모두 따옴표 구절 검색어가 된다.
    assert_eq!(
        parse("a OR NEAR( AND").fts_expression().as_deref(),
        Some("\"a\"* \"OR\"* \"NEAR(\"* \"AND\"*")
    );
    // 짝이 안 맞는 따옴표는 나머지를 한 구절로 묶을 뿐 오류가 되지 않는다.
    assert_eq!(
        parse("a\"b OR").fts_expression().as_deref(),
        Some("\"ab OR\"*")
    );
    assert!(parse("\" - *").is_empty());
    assert!(!parse("is:안읽음").is_empty());
    assert_eq!(
        parse("from:김도윤 to:나").fts_expression().as_deref(),
        Some("{sender sender_email} : \"김도윤\"* recipients : \"나\"*")
    );
}

fn msg(i: u32, folder_sender: (&str, &str), subject: &str, at: i64) -> RemoteMessage {
    RemoteMessage {
        remote_id: i.to_string(),
        thread_id: None,
        dedupe_key: None,
        sender: folder_sender.0.into(),
        sender_email: folder_sender.1.into(),
        recipients: "me@gmail.com".into(),
        subject: subject.into(),
        body: format!("{subject} 본문 {i}"),
        html: None,
        received_at: at,
        unread: i.is_multiple_of(2),
        starred: i.is_multiple_of(5),
        labels: Vec::new(),
        attachments: Vec::new(),
        inline_images: Vec::new(),
    }
}

fn store_with_mail() -> Store {
    use crate::providers::FolderKind;
    let store = Store::open_in_memory().unwrap();
    for (acct, color) in [("a1", 1), ("a2", 2)] {
        store
            .insert_account(&NewAccount {
                id: acct.into(),
                name: acct.into(),
                email: format!("{acct}@mail.com"),
                provider: "gmail".into(),
                color_index: color,
            })
            .unwrap();
        let folders: Vec<RemoteFolder> = [
            ("inbox", FolderKind::Inbox),
            ("trash", FolderKind::Trash),
            ("spam", FolderKind::Spam),
        ]
        .into_iter()
        .map(|(k, kind)| RemoteFolder {
            key: k.into(),
            name: k.into(),
            path: k.into(),
            kind,
            color_index: None,
            depth: 0,
            expandable: false,
        })
        .collect();
        store.save_folders(acct, &folders).unwrap();
    }
    store
}

fn fill(store: &Store) {
    let inbox: Vec<RemoteMessage> = (0..30)
        .map(|i| {
            let who = if i % 3 == 0 {
                ("김도윤", "doyun@gmail.com")
            } else {
                ("한결카드", "card@hangyeol.com")
            };
            let mut m = msg(
                i,
                who,
                &format!("항공권 안내 {i}"),
                1_700_000_000 + i64::from(i) * 1000,
            );
            m.has_attachment_for_test();
            m
        })
        .collect();
    store.save_messages("a1", "inbox", &inbox).unwrap();
    store
        .save_messages(
            "a1",
            "trash",
            &[msg(
                100,
                ("스팸러", "s@s.com"),
                "항공권 휴지통",
                1_700_500_000,
            )],
        )
        .unwrap();
    store
        .save_messages(
            "a2",
            "spam",
            &[msg(
                101,
                ("스팸러", "s@s.com"),
                "항공권 스팸",
                1_700_500_000,
            )],
        )
        .unwrap();
    store
        .save_messages(
            "a2",
            "inbox",
            &[msg(
                102,
                ("김도윤", "doyun@gmail.com"),
                "항공권 다른 계정",
                1_700_600_000,
            )],
        )
        .unwrap();
}

trait AttachForTest {
    fn has_attachment_for_test(&mut self);
}
impl AttachForTest for RemoteMessage {
    fn has_attachment_for_test(&mut self) {
        if self.remote_id.parse::<u32>().unwrap_or(0) % 4 == 0 {
            self.attachments.push(crate::providers::RemoteAttachment {
                name: "a.pdf".into(),
                size: 10,
                mime: "application/pdf".into(),
                part_index: 0,
            });
        }
    }
}

fn run(
    store: &Store,
    query: &str,
    account: Option<&str>,
    cursor: Option<&str>,
    limit: u32,
) -> SearchPage {
    let parsed = parse(query);
    store
        .search_page(&SearchRequest {
            account_id: account,
            query: &parsed,
            sort: MailSort::Newest,
            cursor,
            limit,
        })
        .unwrap()
}

#[test]
fn 스팸과_휴지통은_검색에서_빠진다() {
    let store = store_with_mail();
    fill(&store);
    let page = run(&store, "항공권", None, None, 200);
    assert_eq!(page.total, 31);
    assert!(page
        .mails
        .iter()
        .all(|m| !m.folder_id.ends_with("trash") && !m.folder_id.ends_with("spam")));
    assert_eq!(run(&store, "항공권", Some("a2"), None, 200).total, 1);
}

#[test]
fn 연산자_필터가_걸린다() {
    let store = store_with_mail();
    fill(&store);
    let from = run(&store, "from:한결카드", Some("a1"), None, 200);
    assert_eq!(from.total, 20);
    assert!(from.mails.iter().all(|m| m.sender == "한결카드"));
    // 주소로도 찾는다.
    assert_eq!(
        run(&store, "from:doyun@gmail.com", None, None, 200).total,
        11
    );
    assert_eq!(run(&store, "to:me", None, None, 200).total, 31);
    let unread = run(&store, "is:안읽음 항공권", Some("a1"), None, 200);
    assert!(unread.total > 0 && unread.mails.iter().all(|m| m.unread));
    assert!(run(&store, "is:별표", None, None, 200)
        .mails
        .iter()
        .all(|m| m.starred));
    assert!(run(&store, "has:첨부", None, None, 200)
        .mails
        .iter()
        .all(|m| m.has_attachment));
    // 필터만 있는 질의도 된다.
    assert!(run(&store, "is:읽음", None, None, 200).total > 0);
    // 기간
    let ranged = run(
        &store,
        "after:2023-11-15 before:2023-11-16",
        None,
        None,
        200,
    );
    assert!(ranged
        .mails
        .iter()
        .all(|m| (1_700_006_400 - KST..1_700_092_800 - KST).contains(&m.received_at)));
}

#[test]
fn 기간_밖_결과_수를_센다() {
    let store = store_with_mail();
    fill(&store);
    // 1_700_000_000 + 1000*i 중 i >= 15 가 이 날짜 이후
    let page = run(&store, "항공권 after:2023-11-15", Some("a1"), None, 200);
    assert!(page.older_count.is_some());
    assert_eq!(page.older_count.unwrap() + page.total, 30);
    assert!(run(&store, "항공권", None, None, 200).older_count.is_none());
}

#[test]
fn 키셋_페이지가_빠짐없이_겹침없이_이어진다() {
    let store = store_with_mail();
    fill(&store);
    for sort in [
        MailSort::Newest,
        MailSort::Oldest,
        MailSort::Sender,
        MailSort::Subject,
        MailSort::Unread,
    ] {
        let parsed = parse("항공권");
        let mut cursor: Option<String> = None;
        let mut all: Vec<String> = Vec::new();
        let mut pages = 0;
        loop {
            let page = store
                .search_page(&SearchRequest {
                    account_id: None,
                    query: &parsed,
                    sort,
                    cursor: cursor.as_deref(),
                    limit: 7,
                })
                .unwrap();
            if pages == 0 {
                assert_eq!(page.total, 31);
            }
            pages += 1;
            all.extend(page.mails.iter().map(|m| m.id.clone()));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        // 한 번에 받은 결과와 같은 순서여야 한다.
        let whole = store
            .search_page(&SearchRequest {
                account_id: None,
                query: &parsed,
                sort,
                cursor: None,
                limit: 200,
            })
            .unwrap();
        let whole_ids: Vec<String> = whole.mails.iter().map(|m| m.id.clone()).collect();
        assert_eq!(all, whole_ids, "{sort:?}");
        assert_eq!(pages, 5, "{sort:?}");
    }
}

#[test]
fn 잘못된_커서는_빈_결과다() {
    let store = store_with_mail();
    fill(&store);
    assert!(run(&store, "항공권", None, Some("엉터리"), 10)
        .mails
        .is_empty());
}

#[test]
fn 보낸사람_집계가_메일과_함께_움직인다() {
    let store = store_with_mail();
    fill(&store);
    assert_eq!(
        store.sender_count("a1", "doyun@gmail.com").unwrap(),
        Some(10)
    );
    let top = store.suggest_senders(None, "", 5).unwrap();
    assert_eq!(top[0].email, "card@hangyeol.com");
    assert_eq!(top[0].mail_count, 20);
    let by_name = store.suggest_senders(Some("a1"), "도윤", 5).unwrap();
    assert_eq!(by_name.len(), 1);
    assert_eq!(by_name[0].email, "doyun@gmail.com");
    // LIKE 와일드카드는 글자 그대로다.
    assert!(store.suggest_senders(None, "%", 5).unwrap().is_empty());
    // 내 주소는 추천에서 빠진다.
    store
        .save_messages(
            "a1",
            "inbox",
            &[msg(200, ("나", "a1@mail.com"), "내가 보낸", 1_700_700_000)],
        )
        .unwrap();
    assert!(store.suggest_senders(None, "a1@", 5).unwrap().is_empty());
    // 계정을 지우면 집계도 사라진다.
    store.delete_account("a1").unwrap();
    assert_eq!(store.sender_count("a1", "doyun@gmail.com").unwrap(), None);
}

#[test]
fn 일반_질의는_전체_스캔을_하지_않는다() {
    let store = store_with_mail();
    fill(&store);
    for q in [
        "항공권",
        "from:한결카드 is:안읽음",
        "is:안읽음",
        "has:첨부",
        "after:2023-11-15",
    ] {
        let parsed = parse(q);
        let plan = store
            .explain_search(
                &SearchRequest {
                    account_id: None,
                    query: &parsed,
                    sort: MailSort::Newest,
                    cursor: None,
                    limit: 100,
                },
                Strategy::Match,
            )
            .unwrap()
            .join("\n");
        assert!(!plan.lines().any(|l| l == "SCAN m"), "{q}\n{plan}");
    }
}

#[test]
fn 인덱스_순서_방식도_같은_결과를_낸다() {
    let store = store_with_mail();
    fill(&store);
    for sort in [
        MailSort::Newest,
        MailSort::Oldest,
        MailSort::Sender,
        MailSort::Subject,
        MailSort::Unread,
    ] {
        for q in [
            "항공권",
            "항공권 is:안읽음",
            "from:한결카드 항공권 has:첨부",
        ] {
            let parsed = parse(q);
            let mut results = Vec::new();
            for strategy in [Strategy::Match, Strategy::Ordered(sort)] {
                // 두 방식 모두 처음부터 끝까지 한 페이지 5건씩 이어 받는다.
                let mut cursor: Option<String> = None;
                let mut ids = Vec::new();
                loop {
                    let page = store
                        .search_page_with(
                            &SearchRequest {
                                account_id: None,
                                query: &parsed,
                                sort,
                                cursor: cursor.as_deref(),
                                limit: 5,
                            },
                            Some(strategy),
                        )
                        .unwrap();
                    ids.extend(page.mails.iter().map(|m| m.id.clone()));
                    cursor = page.next_cursor;
                    if cursor.is_none() {
                        break;
                    }
                }
                results.push(ids);
            }
            assert!(!results[0].is_empty(), "{q}");
            assert_eq!(results[0], results[1], "{q} {sort:?}");
        }
    }
}

#[test]
fn 계정별_건수는_스팸_휴지통을_빼고_센다() {
    let store = store_with_mail();
    fill(&store);
    let counts = store.search_scope_counts(&parse("항공권")).unwrap();
    let by = |id: &str| counts.iter().find(|c| c.account_id == id).unwrap().count;
    assert_eq!((by("a1"), by("a2")), (30, 1));
    assert!(counts.iter().all(|c| !c.capped));
    // 필터가 걸린 건수는 결과 목록의 전체 건수와 같다.
    let q = "항공권 is:안읽음";
    let counts = store.search_scope_counts(&parse(q)).unwrap();
    let a1 = counts.iter().find(|c| c.account_id == "a1").unwrap().count;
    assert_eq!(a1, run(&store, q, Some("a1"), None, 200).total);
    // 찾을 조건이 없으면 모두 0
    let empty = store.search_scope_counts(&parse("")).unwrap();
    assert_eq!(empty.len(), 2);
    assert!(empty.iter().all(|c| c.count == 0));
}

#[test]
fn 검색_결과에도_라벨이_담긴다() {
    let store = store_with_mail();
    let mut m = msg(1, ("김도윤", "d@g.com"), "항공권 라벨", 1_700_000_000);
    m.labels = vec!["Work".into(), "여행/제주".into()];
    store.save_messages("a1", "inbox", &[m]).unwrap();
    let page = run(&store, "항공권", None, None, 10);
    let names: Vec<_> = page.mails[0]
        .labels
        .iter()
        .map(|l| l.name.as_str())
        .collect();
    assert_eq!(names, ["Work", "여행/제주"]);
}
