//! 합성 메일 데이터로 검색 성능을 재는 도구와 `#[ignore]` 테스트.
//!
//! 실제 메일함(계정당 수만~십만 통)에서 느려지는 곳은 테스트용 소량 데이터로는 드러나지 않는다.
//! 계정 3개·본문 평균 2KB·한글/영문 혼합 메일을 임시 DB 파일에 채우고 목표 시간을 확인한다.
//!
//! 실행(릴리스 빌드 권장, 디버그는 수십 배 느리다):
//! `cd src-tauri && cargo test --release store::search::perf -- --ignored --nocapture --test-threads=1`
//!
//! 환경 변수: `MYMAIL_PERF_N`(총 메일 수, 기본 100000), `MYMAIL_PERF_KEEP=1`(임시 DB를 지우지 않음).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::params;

use super::*;
use crate::store::{make_preview, NewAccount};

/// 외부 의존 없는 xorshift 난수. 같은 시드는 같은 데이터를 만든다.
pub(super) struct Rng(u64);

impl Rng {
    pub(super) fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

const SYLLABLES: &[&str] = &[
    "가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하", "고", "노",
    "도", "로", "모", "보", "소", "오", "조", "초", "토", "포", "호", "구", "누", "두", "루", "무",
    "부", "수", "우", "주", "추", "투", "푸", "후", "기", "니", "디", "리", "미", "비", "시", "이",
    "지", "치", "한", "결", "서", "연", "민", "재", "윤", "현", "영", "진",
];
const LETTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyz";

/// 자주 나오는 순서로 놓은 단어 사전. 앞쪽 단어일수록 많은 메일에 들어 있다.
pub(super) struct Vocab {
    words: Vec<String>,
}

impl Vocab {
    pub(super) fn new(size: usize) -> Self {
        let mut rng = Rng::new(7);
        // 앞쪽은 실제 검색어로 쓸 말.
        let mut words: Vec<String> = ["회의", "meeting", "견적서", "invoice", "항공권", "배송"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        while words.len() < size {
            let w = if rng.below(10) < 6 {
                (0..2 + rng.below(3))
                    .map(|_| SYLLABLES[rng.below(SYLLABLES.len() as u64) as usize])
                    .collect::<String>()
            } else {
                (0..3 + rng.below(7))
                    .map(|_| LETTERS[rng.below(26) as usize] as char)
                    .collect::<String>()
            };
            words.push(w);
        }
        Self { words }
    }

    /// 앞쪽 단어가 훨씬 자주 나오게 치우친 선택(지프 분포와 비슷).
    fn pick(&self, rng: &mut Rng) -> &str {
        let u = rng.unit();
        &self.words[((u * u * u) * self.words.len() as f64) as usize]
    }

    fn text(&self, rng: &mut Rng, target_bytes: usize) -> String {
        let mut s = String::with_capacity(target_bytes + 16);
        while s.len() < target_bytes {
            if !s.is_empty() {
                s.push(' ');
            }
            s.push_str(self.pick(rng));
        }
        s
    }
}

/// 합성 데이터 요약.
pub(super) struct Seeded {
    pub(super) messages: usize,
    /// 본문 바이트 합계
    pub(super) body_bytes: u64,
    pub(super) elapsed: Duration,
}

/// 계정 3개와 계정마다 폴더 4개(받은편지함·보낸편지함·휴지통·스팸)를 만들고 메일 `n`통을 채운다.
/// 모든 삽입은 트랜잭션 몇 개로 묶는다(동기화가 하는 방식과 같다).
pub(super) fn seed_synthetic(store: &Store, n: usize) -> Seeded {
    let started = Instant::now();
    let vocab = Vocab::new(7000);
    let mut rng = Rng::new(42);
    for a in 0..3 {
        store
            .insert_account(&NewAccount {
                id: format!("acct{a}"),
                name: format!("계정{a}"),
                email: format!("me{a}@mail.com"),
                provider: "gmail".into(),
                color_index: a as u8 + 1,
            })
            .unwrap();
    }
    let kinds = ["inbox", "sent", "trash", "spam"];
    // 받은편지함이 대부분이고 휴지통·스팸은 적다.
    let weights = [80u64, 10, 5, 5];
    let senders: Vec<(String, String)> = (0..400)
        .map(|i| {
            let name: String = (0..2 + rng.below(2))
                .map(|_| SYLLABLES[rng.below(SYLLABLES.len() as u64) as usize])
                .collect();
            (name, format!("user{i}@domain{}.com", i % 17))
        })
        .collect();

    let mut conn = store.lock().unwrap();
    {
        let tx = conn.transaction().unwrap();
        for a in 0..3 {
            for (pos, kind) in kinds.iter().enumerate() {
                tx.execute(
                    "INSERT INTO folders (id, account_id, name, kind, position) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![format!("acct{a}-{kind}"), format!("acct{a}"), kind, kind, pos as i64],
                )
                .unwrap();
            }
        }
        tx.commit().unwrap();
    }
    let mut body_bytes = 0u64;
    let base = 1_760_000_000i64;
    let batch = 5_000;
    let mut written = 0;
    while written < n {
        let tx = conn.transaction().unwrap();
        {
            let mut insert = tx
                .prepare_cached(
                    "INSERT INTO messages (id, account_id, folder_id, thread_id, sender, sender_email,
                         recipients, subject, preview, body, received_at, unread, starred, has_attachment)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                )
                .unwrap();
            for i in written..(written + batch).min(n) {
                let a = rng.below(3);
                let mut pick = rng.below(100);
                let k = weights
                    .iter()
                    .position(|w| {
                        if pick < *w {
                            true
                        } else {
                            pick -= w;
                            false
                        }
                    })
                    .unwrap();
                // 한글 3바이트·영문 1바이트가 섞여 평균 2KB 안팎이 되게 한다.
                let body_len = 1_000 + rng.below(2_000) as usize;
                let body = vocab.text(&mut rng, body_len);
                body_bytes += body.len() as u64;
                let (name, email) = &senders[(rng.unit().powi(2) * 400.0) as usize];
                let subject_len = 20 + rng.below(30) as usize;
                let subject = vocab.text(&mut rng, subject_len);
                let folder = format!("acct{a}-{}", kinds[k]);
                // 스레드: 메일 5통에 하나꼴로 묶는다.
                let thread = format!("t{a}-{}", i / 5);
                insert
                    .execute(params![
                        format!("{folder}-{i}"),
                        format!("acct{a}"),
                        folder,
                        thread,
                        name,
                        email,
                        format!("me{a}@mail.com"),
                        subject,
                        make_preview(&body),
                        body,
                        base - rng.below(126_000_000) as i64,
                        rng.below(10) == 0,
                        rng.below(20) == 0,
                        rng.below(7) == 0,
                    ])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
        written = (written + batch).min(n);
    }
    drop(conn);
    Seeded {
        messages: n,
        body_bytes,
        elapsed: started.elapsed(),
    }
}

fn temp_db(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mymail-perf-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("perf.sqlite")
}

fn cleanup(path: &std::path::Path) {
    if std::env::var("MYMAIL_PERF_KEEP").is_ok() {
        println!("임시 DB를 남겼어요: {}", path.display());
    } else if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn total_messages() -> usize {
    std::env::var("MYMAIL_PERF_N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(100_000)
}

struct Timing {
    first: Duration,
    median: Duration,
    worst: Duration,
}

/// 같은 검색을 여러 번 돌려 처음(캐시 차가운) 시간·중앙값·최악을 잰다.
fn measure(
    store: &Store,
    label: &str,
    query: &str,
    sort: MailSort,
    account: Option<&str>,
) -> Timing {
    let parsed = ParsedQuery::parse(query, 9 * 3600);
    let run = || {
        let t = Instant::now();
        let page = store
            .search_page(&SearchRequest {
                account_id: account,
                query: &parsed,
                sort,
                cursor: None,
                limit: DEFAULT_PAGE,
            })
            .unwrap();
        (t.elapsed(), page)
    };
    let (first, page) = run();
    let mut times: Vec<Duration> = (0..7).map(|_| run().0).collect();
    times.sort();
    let timing = Timing {
        first,
        median: times[times.len() / 2],
        worst: *times.last().unwrap(),
    };
    println!(
        "{label:<34} 결과 {:>5}{} | 처음 {:>6.1}ms  중앙 {:>6.1}ms  최악 {:>6.1}ms",
        page.total,
        if page.total_capped { "+" } else { " " },
        timing.first.as_secs_f64() * 1e3,
        timing.median.as_secs_f64() * 1e3,
        timing.worst.as_secs_f64() * 1e3,
    );
    timing
}

fn open_perf_store(tag: &str) -> (Store, PathBuf) {
    let path = temp_db(tag);
    let store = Store::open(&path).unwrap();
    (store, path)
}

fn file_size(path: &std::path::Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

#[test]
#[ignore = "합성 10만 통을 채우는 느린 측정. cargo test --release store::search::perf -- --ignored --nocapture"]
fn 합성_10만통_검색_성능() {
    let (store, path) = open_perf_store("search");
    let n = total_messages();
    let seeded = seed_synthetic(&store, n);
    println!(
        "\n합성 메일 {}통 삽입 {:.1}초 (본문 합계 {:.1}MB, 평균 {}B)",
        seeded.messages,
        seeded.elapsed.as_secs_f64(),
        seeded.body_bytes as f64 / 1e6,
        seeded.body_bytes / seeded.messages as u64
    );
    store
        .lock()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;")
        .unwrap();
    let db_bytes = file_size(&path);
    println!(
        "DB 파일 {:.1}MB = 본문 합계의 {:.2}배",
        db_bytes as f64 / 1e6,
        db_bytes as f64 / seeded.body_bytes as f64
    );
    // 테이블·인덱스별 크기(dbstat). 어디가 큰지 보려는 참고 출력이다.
    if let Ok(conn) = store.read_lock() {
        if let Ok(mut stmt) = conn
            .prepare("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC LIMIT 14")
        {
            if let Ok(rows) =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            {
                for (name, bytes) in rows.flatten() {
                    println!("  {name:<34} {:>7.1}MB", bytes as f64 / 1e6);
                }
            }
        }
    }

    let target = Duration::from_millis(100);
    let mut over: Vec<String> = Vec::new();
    let mut check = |label: &str, t: Timing| {
        if t.median > target {
            over.push(format!("{label}: 중앙 {:?}", t.median));
        }
    };

    println!("\n--- 첫 페이지(100건 + 전체 건수 세기 포함) ---");
    // 단어 순위가 낮을수록 드문 단어
    check(
        "일반 검색어(한글)",
        measure(&store, "일반: 견적서", "견적서", MailSort::Newest, None),
    );
    check(
        "일반 검색어(영문)",
        measure(&store, "일반: invoice", "invoice", MailSort::Newest, None),
    );
    measure(
        &store,
        "최다 빈출어(최악): 회의",
        "회의",
        MailSort::Newest,
        None,
    );
    measure(
        &store,
        "최다 빈출어(최악): meeting",
        "meeting",
        MailSort::Newest,
        None,
    );
    check(
        "드문 검색어",
        measure(
            &store,
            "드문 단어: 가나다라",
            "가나다라",
            MailSort::Newest,
            None,
        ),
    );
    check(
        "두 단어 AND",
        measure(
            &store,
            "견적서 항공권",
            "견적서 항공권",
            MailSort::Newest,
            None,
        ),
    );
    check(
        "한 계정만",
        measure(
            &store,
            "견적서 (acct1)",
            "견적서",
            MailSort::Newest,
            Some("acct1"),
        ),
    );
    println!("--- 필터 조합 ---");
    check(
        "from:",
        measure(
            &store,
            "from:user5@domain5.com",
            "from:user5@domain5.com",
            MailSort::Newest,
            None,
        ),
    );
    check(
        "from: + 검색어",
        measure(
            &store,
            "견적서 from:user3@domain3.com",
            "견적서 from:user3@domain3.com",
            MailSort::Newest,
            None,
        ),
    );
    check(
        "is:안읽음 (필터만)",
        measure(&store, "is:안읽음", "is:안읽음", MailSort::Newest, None),
    );
    check(
        "is:별표 (필터만)",
        measure(&store, "is:별표", "is:별표", MailSort::Newest, None),
    );
    check(
        "has:첨부 (필터만)",
        measure(&store, "has:첨부", "has:첨부", MailSort::Newest, None),
    );
    check(
        "검색어 + is:안읽음 + has:첨부",
        measure(
            &store,
            "견적서 is:안읽음 has:첨부",
            "견적서 is:안읽음 has:첨부",
            MailSort::Newest,
            None,
        ),
    );
    check(
        "기간 필터",
        measure(
            &store,
            "견적서 after:2026-06-01",
            "견적서 after:2026-06-01",
            MailSort::Newest,
            None,
        ),
    );
    check(
        "기간 필터만",
        measure(
            &store,
            "after:2026-06-01",
            "after:2026-06-01",
            MailSort::Newest,
            None,
        ),
    );
    println!("--- 정렬 5종 (일반 검색어 '견적서') ---");
    for (name, sort) in [
        ("최신", MailSort::Newest),
        ("오래된", MailSort::Oldest),
        ("보낸사람", MailSort::Sender),
        ("제목", MailSort::Subject),
        ("안 읽음 먼저", MailSort::Unread),
    ] {
        check(
            name,
            measure(&store, &format!("정렬 {name}"), "견적서", sort, None),
        );
    }
    println!("--- 정렬 5종 (필터만 'has:첨부') ---");
    for (name, sort) in [
        ("최신", MailSort::Newest),
        ("오래된", MailSort::Oldest),
        ("보낸사람", MailSort::Sender),
        ("제목", MailSort::Subject),
        ("안 읽음 먼저", MailSort::Unread),
    ] {
        measure(&store, &format!("정렬 {name}"), "has:첨부", sort, None);
    }

    println!("--- 키셋 다음 페이지 ---");
    {
        let parsed = ParsedQuery::parse("견적서", 0);
        let first = store
            .search_page(&SearchRequest {
                account_id: None,
                query: &parsed,
                sort: MailSort::Newest,
                cursor: None,
                limit: DEFAULT_PAGE,
            })
            .unwrap();
        let cursor = first.next_cursor.unwrap();
        let t = Instant::now();
        let second = store
            .search_page(&SearchRequest {
                account_id: None,
                query: &parsed,
                sort: MailSort::Newest,
                cursor: Some(&cursor),
                limit: DEFAULT_PAGE,
            })
            .unwrap();
        let took = t.elapsed();
        println!(
            "두 번째 페이지 {:.1}ms ({}건)",
            took.as_secs_f64() * 1e3,
            second.mails.len()
        );
        assert!(took < target);
    }

    println!("--- 보낸사람 추천 ---");
    {
        let t = Instant::now();
        let s = store.suggest_senders(None, "", 5).unwrap();
        let empty_took = t.elapsed();
        let t = Instant::now();
        let s2 = store.suggest_senders(None, "user1", 5).unwrap();
        println!(
            "추천(빈 입력) {:.1}ms ({}건), 추천('user1') {:.1}ms ({}건)",
            empty_took.as_secs_f64() * 1e3,
            s.len(),
            t.elapsed().as_secs_f64() * 1e3,
            s2.len()
        );
        assert!(empty_took < target);
    }

    println!("--- EXPLAIN QUERY PLAN (전체 스캔 점검) ---");
    for q in [
        "견적서",
        "견적서 from:user3@domain3.com",
        "is:안읽음",
        "has:첨부",
        "after:2026-06-01",
        "is:별표 has:첨부",
    ] {
        for sort in [MailSort::Newest, MailSort::Sender] {
            for strategy in [Strategy::Match, Strategy::Ordered(sort)] {
                let parsed = ParsedQuery::parse(q, 0);
                let plan = store
                    .explain_search(
                        &SearchRequest {
                            account_id: None,
                            query: &parsed,
                            sort,
                            cursor: None,
                            limit: DEFAULT_PAGE,
                        },
                        strategy,
                    )
                    .unwrap();
                println!(
                    "[{q} / {sort:?} / {}] {}",
                    if strategy == Strategy::Match {
                        "Match"
                    } else {
                        "Ordered"
                    },
                    plan.join(" | ")
                );
                assert!(
                    !plan.iter().any(|l| l == "SCAN m"),
                    "messages 전체 스캔: {q} {sort:?}"
                );
            }
        }
    }

    println!("\n--- 참고: 이 작업 전 방식(LIMIT 없음 + 행마다 스레드 수 서브쿼리) '견적서' ---");
    {
        let conn = store.read_lock().unwrap();
        let t = Instant::now();
        let n: usize = conn
            .prepare(
                "SELECT m.id, m.account_id, m.folder_id, m.sender, m.sender_email, m.subject, m.preview,
                        m.received_at, m.unread, m.starred, m.has_attachment, m.labels, m.label_name,
                        CASE WHEN m.thread_id IS NULL THEN 0
                             ELSE (SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.thread_id) END
                 FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
                 WHERE messages_fts MATCH '\"견적서\"*' ORDER BY m.received_at DESC, m.id",
            )
            .unwrap()
            .query_map([], summary_from_row)
            .unwrap()
            .count();
        println!("전부 읽기 {n}건 {:.1}ms", t.elapsed().as_secs_f64() * 1e3);
    }

    cleanup(&path);
    assert!(over.is_empty(), "100ms 목표를 넘은 항목: {over:#?}");
    assert!(
        db_bytes as f64 <= seeded.body_bytes as f64 * 2.05,
        "DB 크기가 본문 합계의 2배를 넘음: {:.2}배",
        db_bytes as f64 / seeded.body_bytes as f64
    );
}

#[test]
#[ignore = "느린 측정. cargo test --release store::search::perf -- --ignored --nocapture"]
fn 동기화_쓰기_중에도_검색이_막히지_않는다() {
    let (store, path) = open_perf_store("concurrent");
    let n = (total_messages() / 3).max(10_000);
    seed_synthetic(&store, n);
    let store = Arc::new(store);

    let stop = Arc::new(AtomicBool::new(false));
    let writer = {
        let store = Arc::clone(&store);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            let mut rng = Rng::new(99);
            let mut written = 0u64;
            let mut longest_tx = Duration::ZERO;
            while !stop.load(Ordering::Relaxed) {
                let t = Instant::now();
                let mut conn = store.lock().unwrap();
                let tx = conn.transaction().unwrap();
                for _ in 0..300 {
                    written += 1;
                    tx.execute(
                        "INSERT INTO messages (id, account_id, folder_id, sender, sender_email, recipients,
                             subject, preview, body, received_at, unread, starred, has_attachment)
                         VALUES (?1, 'acct0', 'acct0-inbox', '동기화', 'sync@x.com', 'me0@mail.com',
                             '동기화 중 도착', '', ?2, ?3, 1, 0, 0)",
                        params![format!("sync-{written}"), format!("견적서 {}", rng.next()), 1_760_000_000 + written as i64],
                    )
                    .unwrap();
                }
                tx.commit().unwrap();
                drop(conn);
                longest_tx = longest_tx.max(t.elapsed());
            }
            (written, longest_tx)
        })
    };

    std::thread::sleep(Duration::from_millis(200));
    let parsed = ParsedQuery::parse("견적서", 0);
    let mut worst = Duration::ZERO;
    let mut runs = 0;
    let end = Instant::now() + Duration::from_secs(3);
    while Instant::now() < end {
        let t = Instant::now();
        store
            .search_page(&SearchRequest {
                account_id: None,
                query: &parsed,
                sort: MailSort::Newest,
                cursor: None,
                limit: DEFAULT_PAGE,
            })
            .unwrap();
        worst = worst.max(t.elapsed());
        runs += 1;
    }
    stop.store(true, Ordering::Relaxed);
    let (written, longest_tx) = writer.join().unwrap();
    println!(
        "\n동기화 쓰기 {written}통 (가장 긴 쓰기 트랜잭션 {:.1}ms) 동안 검색 {runs}회, 최악 {:.1}ms",
        longest_tx.as_secs_f64() * 1e3,
        worst.as_secs_f64() * 1e3
    );
    cleanup(&path);
    assert!(
        worst < Duration::from_millis(300),
        "쓰기 중 검색이 막혔어요: {worst:?}"
    );
}

fn median_ms(mut f: impl FnMut()) -> f64 {
    f(); // 데운다
    let mut v: Vec<f64> = (0..7)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

fn size_of(conn: &rusqlite::Connection, like: &str) -> f64 {
    conn.query_row(
        "SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name LIKE ?1",
        [like],
        |r| r.get::<_, i64>(0),
    )
    .unwrap() as f64
        / 1e6
}

#[test]
#[ignore = "느린 측정(결과만 docs/decisions.md에 기록). cargo test --release store::search::perf::동기화_대량 -- --ignored --nocapture"]
fn 동기화_대량_삽입의_트리거_비용() {
    let n = (total_messages() / 2).max(10_000);
    // 트리거를 모두 둔 기본 상태
    let (full, p1) = open_perf_store("trig-full");
    let with_all = seed_synthetic(&full, n).elapsed;
    // sender_stats 트리거만 뺀 상태
    let (no_stats, p2) = open_perf_store("trig-nostats");
    no_stats
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER sender_stats_ai;")
        .unwrap();
    let without_stats = seed_synthetic(&no_stats, n).elapsed;
    // FTS·sender_stats 트리거를 모두 뺀 상태(나중에 'rebuild'로 한꺼번에 만드는 대안의 하한)
    let (bare, p3) = open_perf_store("trig-bare");
    bare.lock()
        .unwrap()
        .execute_batch("DROP TRIGGER sender_stats_ai; DROP TRIGGER messages_ai;")
        .unwrap();
    let bare_elapsed = seed_synthetic(&bare, n).elapsed;
    let t = Instant::now();
    bare.lock()
        .unwrap()
        .execute_batch("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');")
        .unwrap();
    let rebuild = t.elapsed();
    // 삽입 뒤 FTS 병합 비용(배치 optimize)
    let t = Instant::now();
    full.lock()
        .unwrap()
        .execute_batch("INSERT INTO messages_fts(messages_fts) VALUES ('optimize');")
        .unwrap();
    let optimize = t.elapsed();

    let s = |d: Duration| d.as_secs_f64();
    println!(
        "\n{n}통 삽입(트랜잭션 5,000통씩; 합성 데이터 생성 시간 포함)\n  모든 트리거:           {:.2}초 ({:.1}μs/통)\n  sender_stats 트리거 X: {:.2}초 (트리거 비용 {:+.1}%)\n  FTS+집계 트리거 X:     {:.2}초 + 'rebuild' {:.2}초 = {:.2}초\n  삽입 뒤 FTS optimize:  {:.2}초",
        s(with_all),
        s(with_all) * 1e6 / n as f64,
        s(without_stats),
        (s(with_all) / s(without_stats) - 1.0) * 100.0,
        s(bare_elapsed),
        s(rebuild),
        s(bare_elapsed) + s(rebuild),
        s(optimize),
    );
    for p in [&p1, &p2, &p3] {
        cleanup(p);
    }
}

#[test]
#[ignore = "느린 측정(결과만 docs/decisions.md에 기록). cargo test --release store::search::perf::trigram -- --ignored --nocapture"]
fn trigram_bm25_측정() {
    let (store, path) = open_perf_store("tokenizer");
    let n = total_messages();
    let seeded = seed_synthetic(&store, n);
    let conn = store.lock().unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();

    let t = Instant::now();
    conn.execute_batch(
        "CREATE VIRTUAL TABLE tri USING fts5(subject, sender, sender_email, recipients, body,
             content = 'messages', content_rowid = 'rowid', tokenize = 'trigram', columnsize = 0);
         INSERT INTO tri(tri) VALUES ('rebuild');",
    )
    .unwrap();
    let build = t.elapsed();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    let body = seeded.body_bytes as f64 / 1e6;
    let uni = size_of(&conn, "messages_fts%");
    let tri = size_of(&conn, "tri%");
    println!(
        "\n본문 합계 {body:.1}MB\n  unicode61 인덱스 {uni:.1}MB ({:.2}배)\n  trigram   인덱스 {tri:.1}MB ({:.2}배, 만드는 데 {:.1}초)",
        uni / body,
        tri / body,
        build.as_secs_f64()
    );

    let count = |table: &str, expr: &str| -> i64 {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM (SELECT rowid FROM {table} WHERE {table} MATCH ?1 LIMIT 1001)"),
            [expr],
            |r| r.get(0),
        )
        .unwrap()
    };
    println!("--- 일치 건수 상한 1,001 / 첫 1,001건 세는 시간(중앙값) ---");
    for (label, uni_expr, tri_expr) in [
        ("단어 전체 '견적서'", "\"견적서\"*", "\"견적서\""),
        ("단어 앞부분 '견적'", "\"견적\"*", "\"견적\""),
        ("단어 중간 '적서'", "\"적서\"*", "\"적서\""),
        ("영문 'invoice'", "\"invoice\"*", "\"invoice\""),
        ("영문 중간 'voic'", "\"voic\"*", "\"voic\""),
    ] {
        let mut un = 0;
        let mut tn = 0;
        let um = median_ms(|| un = count("messages_fts", uni_expr));
        let tm = median_ms(|| tn = count("tri", tri_expr));
        println!("{label:<20} unicode61 {un:>5}건 {um:>6.1}ms | trigram {tn:>5}건 {tm:>6.1}ms");
    }

    println!("--- 관련도(bm25) 정렬 vs 최신순, 첫 100건 ---");
    for (label, word) in [("빈출어 '회의'", "회의"), ("보통 '견적서'", "견적서")] {
        let expr = format!("\"{word}\"*");
        let newest = median_ms(|| {
            conn.prepare_cached(
                "SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
                 WHERE messages_fts MATCH ?1 ORDER BY m.received_at DESC, m.id LIMIT 100",
            )
            .unwrap()
            .query_map([&expr], |r| r.get::<_, String>(0))
            .unwrap()
            .count();
        });
        let bm25 = median_ms(|| {
            conn.prepare_cached(
                "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1
                 ORDER BY bm25(messages_fts, 10.0, 5.0, 5.0, 1.0, 1.0) LIMIT 100",
            )
            .unwrap()
            .query_map([&expr], |r| r.get::<_, i64>(0))
            .unwrap()
            .count();
        });
        println!("{label:<16} 최신순 {newest:>7.1}ms | bm25 {bm25:>7.1}ms");
    }
    drop(conn);
    cleanup(&path);
}

#[test]
#[ignore = "느린 측정. cargo test --release store::search::perf::폴더_목록 -- --ignored --nocapture"]
fn 폴더_목록_페이지_성능() {
    let (store, path) = open_perf_store("folderlist");
    let n = total_messages();
    seed_synthetic(&store, n);
    store
        .lock()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;")
        .unwrap();
    println!("\n--- 폴더 목록 첫 페이지(100건) / 다음 페이지 ---");
    let mut over: Vec<String> = Vec::new();
    for sort in [
        MailSort::Newest,
        MailSort::Oldest,
        MailSort::Sender,
        MailSort::Subject,
        MailSort::Unread,
    ] {
        for (label, account, folder) in [
            ("한 계정 받은편지함", Some("acct1"), "acct1-inbox"),
            ("통합 받은편지함", None, ""),
        ] {
            let mut first_ms = 0.0;
            let mut cursor = None;
            let med = median_ms(|| {
                let t = Instant::now();
                let page = store
                    .list_mails_page(account, folder, sort, None, 100)
                    .unwrap();
                first_ms = t.elapsed().as_secs_f64() * 1e3;
                cursor = page.next_cursor;
            });
            let next = median_ms(|| {
                store
                    .list_mails_page(account, folder, sort, cursor.as_deref(), 100)
                    .unwrap();
            });
            println!("{sort:?} / {label:<18} 첫 페이지 {med:>6.1}ms | 다음 페이지 {next:>6.1}ms");
            if med > 100.0 || next > 100.0 {
                over.push(format!(
                    "{sort:?} / {label}: 첫 {med:.0}ms, 다음 {next:.0}ms"
                ));
            }
        }
    }
    cleanup(&path);
    assert!(over.is_empty(), "100ms 목표를 넘은 항목: {over:#?}");
}
