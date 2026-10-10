//! 검색: 연산자 해석, 필터, 키셋 페이징, 보낸사람 추천.
//!
//! SQL에는 고정된 조각만 이어 붙이고 사용자 입력은 모두 바인딩한다(FTS 식도 바인딩 값이다).

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter};
use serde::Serialize;

use super::{summary_from_row, MailSort, MailSummary, Store, StoreError};

/// 한 페이지의 기본·최대 건수.
pub const DEFAULT_PAGE: u32 = 100;
pub const MAX_PAGE: u32 = 200;
/// 전체 건수를 세는 상한. 넘으면 "1,000+"로 보인다.
pub const COUNT_CAP: u32 = 1000;

/// 검색창 입력을 해석한 결과.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedQuery {
    /// 일반 검색어(제목·보낸사람·본문 접두 검색)
    pub terms: Vec<String>,
    pub from: Vec<String>,
    pub to: Vec<String>,
    pub has_attachment: bool,
    pub unread: Option<bool>,
    pub starred: bool,
    /// 이 시각(포함) 이후, 유닉스 초
    pub after: Option<i64>,
    /// 이 시각(미포함) 이전
    pub before: Option<i64>,
}

impl ParsedQuery {
    /// `tz_offset_secs`는 UTC와의 차이(한국은 32400). 날짜 연산자를 이 시간대의 0시로 바꾼다.
    pub fn parse(input: &str, tz_offset_secs: i64) -> Self {
        let mut q = Self::default();
        for (token, quoted) in tokenize(input) {
            // 따옴표 안에 ':'가 없으면 구절 검색어다.
            if quoted && !token.contains(':') {
                q.terms.push(token);
                continue;
            }
            if !q.apply_operator(&token, tz_offset_secs) {
                q.terms.push(token);
            }
        }
        q
    }

    fn apply_operator(&mut self, token: &str, tz: i64) -> bool {
        let Some((key, value)) = token.split_once(':') else {
            return false;
        };
        let value = value.trim();
        if value.is_empty() {
            return false;
        }
        match key.to_lowercase().as_str() {
            "from" => self.from.push(value.to_owned()),
            "to" => self.to.push(value.to_owned()),
            "has" => match value.to_lowercase().as_str() {
                "첨부" | "attachment" | "attach" => self.has_attachment = true,
                _ => return false,
            },
            "is" => match value.to_lowercase().as_str() {
                "안읽음" | "unread" => self.unread = Some(true),
                "읽음" | "read" => self.unread = Some(false),
                "별표" | "starred" => self.starred = true,
                _ => return false,
            },
            "after" => match parse_date(value) {
                Some(day) => self.after = Some(day - tz),
                None => return false,
            },
            "before" => match parse_date(value) {
                Some(day) => self.before = Some(day - tz),
                None => return false,
            },
            _ => return false,
        }
        true
    }

    /// FTS5 식. 검색어가 없으면 `None`(필터만 있는 질의).
    fn fts_expression(&self) -> Option<String> {
        let mut parts = Vec::new();
        for t in &self.terms {
            if let Some(p) = phrase(t) {
                parts.push(p);
            }
        }
        for f in &self.from {
            if let Some(p) = phrase(f) {
                parts.push(format!("{{sender sender_email}} : {p}"));
            }
        }
        for t in &self.to {
            if let Some(p) = phrase(t) {
                parts.push(format!("recipients : {p}"));
            }
        }
        (!parts.is_empty()).then(|| parts.join(" "))
    }

    fn has_filter(&self) -> bool {
        self.has_attachment
            || self.unread.is_some()
            || self.starred
            || self.after.is_some()
            || self.before.is_some()
    }

    /// 찾을 조건이 하나도 없으면 빈 결과를 돌려준다.
    pub fn is_empty(&self) -> bool {
        self.fts_expression().is_none() && !self.has_filter()
    }
}

/// 따옴표를 지키며 공백으로 나눈다. `from:"한결 카드"`처럼 값에 따옴표가 있으면 값만 벗긴다.
fn tokenize(input: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut was_quoted = false;
    for c in input.chars() {
        match c {
            '"' => {
                in_quote = !in_quote;
                was_quoted = true;
            }
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    out.push((std::mem::take(&mut cur), was_quoted));
                }
                was_quoted = false;
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push((cur, was_quoted));
    }
    out
}

/// 사용자 단어를 FTS5 접두 구절로 바꾼다. 글자나 숫자가 없으면 인덱스에 없는 단어라 버린다.
fn phrase(term: &str) -> Option<String> {
    let cleaned = term.replace('"', "");
    cleaned
        .chars()
        .any(char::is_alphanumeric)
        .then(|| format!("\"{cleaned}\"*"))
}

/// `YYYY-MM-DD`를 UTC 0시의 유닉스 초로 바꾼다. 존재하지 않는 날짜는 `None`.
fn parse_date(s: &str) -> Option<i64> {
    let mut it = s.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.parse().ok()?;
    if it.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let days_in_month = match m {
        2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if d > days_in_month || !(1970..=2200).contains(&y) {
        return None;
    }
    // Howard Hinnant의 days_from_civil
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400)
}

/// 검색 결과 한 페이지.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub mails: Vec<MailSummary>,
    /// 일치하는 전체 건수. `COUNT_CAP`을 넘으면 `COUNT_CAP`이고 `total_capped`가 참이다.
    pub total: u32,
    pub total_capped: bool,
    /// `after:`보다 오래된 일치 건수(상한 `COUNT_CAP`). `after:`가 없으면 `None`.
    pub older_count: Option<u32>,
    /// 다음 페이지를 받을 때 그대로 돌려보내는 값. 마지막 페이지면 `None`.
    pub next_cursor: Option<String>,
}

/// 검색 범위와 페이지 요청.
#[derive(Debug, Clone)]
pub struct SearchRequest<'a> {
    pub account_id: Option<&'a str>,
    pub query: &'a ParsedQuery,
    pub sort: MailSort,
    pub cursor: Option<&'a str>,
    pub limit: u32,
}

/// SQL과 바인딩 값을 쌓는 도구. `?N` 번호를 자동으로 매긴다.
#[derive(Default)]
struct Binds(Vec<Value>);

impl Binds {
    fn push(&mut self, v: impl Into<Value>) -> String {
        self.0.push(v.into());
        format!("?{}", self.0.len())
    }
}

/// 스팸·휴지통은 검색에서 뺀다.
const SCOPE: &str = "f.kind NOT IN ('spam', 'trash')";

/// 검색어 일치 방식.
/// - `Match`: FTS 일치 행을 먼저 모은 뒤 정렬한다. 일치가 적을 때(건수 상한 미만) 빠르다.
/// - `Ordered`: 정렬 인덱스를 순서대로 걸으며 FTS 일치 집합에 든 행을 집다가 `LIMIT`에서 멈춘다.
///   일치가 아주 많을 때 전부를 정렬하지 않으려는 방식이다.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    Match,
    Ordered(MailSort),
}

/// `Ordered`가 걷는 인덱스(0008 마이그레이션). 정렬 5종마다 하나씩이다.
fn order_index(sort: MailSort) -> &'static str {
    match sort {
        MailSort::Newest => "idx_messages_received",
        MailSort::Oldest => "idx_messages_received_asc",
        MailSort::Sender => "idx_messages_sender",
        MailSort::Subject => "idx_messages_subject",
        MailSort::Unread => "idx_messages_unread_first",
    }
}

/// 질의가 걸을 인덱스를 못 박는다. 못 박지 않으면 SQLite가 일치 행을 모아 통째로 정렬하는 계획을 고르기 쉽다.
/// - 검색어가 있고 `Match`: FTS가 이끈다(못 박지 않음).
/// - 별표·안 읽음·첨부 필터: 그 부분 인덱스(가장 드문 것부터). 해당 행만 걷고, 정렬은 그 뒤에 한다.
/// - 그 밖: 정렬 인덱스를 걷는다. 검색어가 있으면 `Ordered`가 고른 정렬, 없으면 요청한 정렬.
fn forced_index(q: &ParsedQuery, strategy: Strategy, sort: MailSort) -> Option<&'static str> {
    let has_fts = q.fts_expression().is_some();
    if has_fts && strategy == Strategy::Match {
        return None;
    }
    if q.starred {
        return Some("idx_messages_starred");
    }
    if q.unread == Some(true) {
        return Some("idx_messages_unread");
    }
    if q.has_attachment {
        return Some("idx_messages_attachment");
    }
    Some(match strategy {
        Strategy::Ordered(s) if has_fts => order_index(s),
        _ => order_index(sort),
    })
}

/// `FROM`/`WHERE` 조각(키셋 조건 제외)을 만든다. `sort`는 못 박을 인덱스를 고르는 데만 쓴다.
fn base_clause(
    q: &ParsedQuery,
    account_id: Option<&str>,
    binds: &mut Binds,
    skip_after: bool,
    strategy: Strategy,
    sort: MailSort,
) -> (String, String) {
    let mut wheres = vec![SCOPE.to_owned()];
    let fts = q.fts_expression();
    let mut from = match forced_index(q, strategy, sort) {
        Some(index) => {
            format!("messages m INDEXED BY {index} JOIN folders f ON f.id = m.folder_id")
        }
        None => String::from("messages m JOIN folders f ON f.id = m.folder_id"),
    };
    if let Some(expr) = fts {
        let p = binds.push(expr);
        if matches!(strategy, Strategy::Ordered(_)) {
            // `+ 0`: rowid 조회로 바뀌지 않고 인덱스 순서를 지키게 한다.
            wheres.push(format!(
                "(m.rowid + 0) IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH {p})"
            ));
        } else {
            from.push_str(" JOIN messages_fts ON messages_fts.rowid = m.rowid");
            wheres.push(format!("messages_fts MATCH {p}"));
        }
    }
    if let Some(a) = account_id {
        let p = binds.push(a.to_owned());
        wheres.push(format!("m.account_id = {p}"));
    }
    if q.has_attachment {
        wheres.push("m.has_attachment = 1".into());
    }
    if let Some(unread) = q.unread {
        wheres.push(format!("m.unread = {}", i32::from(unread)));
    }
    if q.starred {
        wheres.push("m.starred = 1".into());
    }
    if let (Some(t), false) = (q.after, skip_after) {
        let p = binds.push(t);
        wheres.push(format!("m.received_at >= {p}"));
    }
    if let Some(t) = q.before {
        let p = binds.push(t);
        wheres.push(format!("m.received_at < {p}"));
    }
    (from, wheres.join(" AND "))
}

/// 커서: `받은시각 \x1f id \x1f 정렬 키`. 마지막 행의 값으로 만든다.
fn encode_cursor(sort: MailSort, m: &MailSummary) -> String {
    let key = match sort {
        MailSort::Sender => m.sender.clone(),
        MailSort::Subject => m.subject.clone(),
        MailSort::Unread => i32::from(m.unread).to_string(),
        MailSort::Newest | MailSort::Oldest => String::new(),
    };
    format!("{}\x1f{}\x1f{}", m.received_at, m.id, key)
}

/// 커서 뒤의 행만 고르는 조건. 정렬(`MailSort::order_by`)과 같은 순서를 따른다.
fn keyset_clause(sort: MailSort, cursor: &str, binds: &mut Binds) -> Option<String> {
    let mut it = cursor.splitn(3, '\x1f');
    let received: i64 = it.next()?.parse().ok()?;
    let id = it.next()?.to_owned();
    let key = it.next()?.to_owned();
    let r = binds.push(received);
    let i = binds.push(id);
    // 받은 시각 내림차순 + id 오름차순 꼬리
    let tail_desc = format!("(m.received_at < {r} OR (m.received_at = {r} AND m.id > {i}))");
    Some(match sort {
        MailSort::Newest => tail_desc,
        MailSort::Oldest => {
            format!("(m.received_at > {r} OR (m.received_at = {r} AND m.id > {i}))")
        }
        MailSort::Sender | MailSort::Subject => {
            let col = if sort == MailSort::Sender {
                "m.sender"
            } else {
                "m.subject"
            };
            let k = binds.push(key);
            format!("({col} COLLATE NOCASE > {k} OR ({col} COLLATE NOCASE = {k} AND {tail_desc}))")
        }
        MailSort::Unread => {
            let k = binds.push(key.parse::<i64>().ok()?);
            format!("(m.unread < {k} OR (m.unread = {k} AND {tail_desc}))")
        }
    })
}

/// 안쪽 질의에서 한 페이지만 고른 뒤에야 스레드 수를 센다(행마다 서브쿼리가 모든 일치 행에 돌지 않게).
pub(super) fn page_sql(
    req: &SearchRequest<'_>,
    strategy: Strategy,
) -> Option<(String, Vec<Value>)> {
    let mut binds = Binds::default();
    let (from, mut wheres) = base_clause(
        req.query,
        req.account_id,
        &mut binds,
        false,
        strategy,
        req.sort,
    );
    if let Some(c) = req.cursor {
        wheres.push_str(" AND ");
        wheres.push_str(&keyset_clause(req.sort, c, &mut binds)?);
    }
    let limit = binds.push(i64::from(req.limit.clamp(1, MAX_PAGE)) + 1);
    let order = req.sort.order_by();
    let outer_order = order.replace("m.", "p.");
    let sql = format!(
        "SELECT p.id, p.account_id, p.folder_id, p.sender, p.sender_email, p.subject, p.preview,
                p.received_at, p.unread, p.starred, p.has_attachment, p.label_name, p.label_color,
                CASE WHEN p.thread_id IS NULL THEN 0
                     ELSE (SELECT COUNT(*) FROM messages t WHERE t.thread_id = p.thread_id) END
         FROM (SELECT m.id, m.account_id, m.folder_id, m.sender, m.sender_email, m.subject,
                      m.preview, m.received_at, m.unread, m.starred, m.has_attachment,
                      m.label_name, m.label_color, m.thread_id
               FROM {from} WHERE {wheres} ORDER BY {order} LIMIT {limit}) AS p
         ORDER BY {outer_order}"
    );
    Some((sql, binds.0))
}

fn count_sql(
    q: &ParsedQuery,
    account_id: Option<&str>,
    older_than_after: bool,
    strategy: Strategy,
) -> (String, Vec<Value>) {
    let mut binds = Binds::default();
    let (from, mut wheres) = base_clause(
        q,
        account_id,
        &mut binds,
        older_than_after,
        strategy,
        MailSort::Newest,
    );
    if older_than_after {
        if let Some(t) = q.after {
            let p = binds.push(t);
            wheres.push_str(&format!(" AND m.received_at < {p}"));
        }
    }
    let cap = binds.push(i64::from(COUNT_CAP) + 1);
    (
        format!("SELECT COUNT(*) FROM (SELECT 1 FROM {from} WHERE {wheres} LIMIT {cap})"),
        binds.0,
    )
}

/// 보낸사람 추천 한 줄.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderSuggestion {
    pub account_id: String,
    pub name: String,
    pub email: String,
    pub mail_count: u32,
}

impl Store {
    /// 검색어·연산자로 메일을 찾아 한 페이지씩 돌려준다. 읽기 전용 연결을 써서 동기화 쓰기와 서로 막지 않는다.
    pub fn search_page(&self, req: &SearchRequest<'_>) -> Result<SearchPage, StoreError> {
        self.search_page_with(req, None)
    }

    /// `force`가 있으면 일치 방식을 정해 준다(테스트·측정용). 없으면 일치 건수로 고른다.
    pub(super) fn search_page_with(
        &self,
        req: &SearchRequest<'_>,
        force: Option<Strategy>,
    ) -> Result<SearchPage, StoreError> {
        let empty = SearchPage {
            mails: Vec::new(),
            total: 0,
            total_capped: false,
            older_count: None,
            next_cursor: None,
        };
        if req.query.is_empty() {
            return Ok(empty);
        }
        let conn = self.read_lock()?;
        // 검색어에 일치하는 글이 아주 많으면(필터 전 기준, 상한 초과) 정렬 인덱스를 걷는 방식으로 간다.
        let strategy = match (force, req.query.fts_expression()) {
            (Some(forced), _) => forced,
            (None, Some(expr)) => {
                let probe: u32 = conn
                    .prepare_cached(
                        "SELECT COUNT(*) FROM (SELECT rowid FROM messages_fts
                     WHERE messages_fts MATCH ?1 LIMIT ?2)",
                    )?
                    .query_row(params![expr, COUNT_CAP + 1], |r| r.get(0))?;
                if probe > COUNT_CAP {
                    Strategy::Ordered(req.sort)
                } else {
                    Strategy::Match
                }
            }
            (None, None) => Strategy::Match,
        };
        // 건수는 순서가 필요 없지만 같은 방식으로 세야 일치가 많을 때 상한에서 멈춘다.
        let count_strategy = match strategy {
            Strategy::Ordered(_) => Strategy::Ordered(MailSort::Newest),
            Strategy::Match => Strategy::Match,
        };
        let count = |older: bool| -> Result<u32, StoreError> {
            let (sql, binds) = count_sql(req.query, req.account_id, older, count_strategy);
            Ok(conn
                .prepare_cached(&sql)?
                .query_row(params_from_iter(binds), |r| r.get::<_, u32>(0))?)
        };
        let matched = count(false)?;
        let Some((sql, binds)) = page_sql(req, strategy) else {
            return Ok(empty); // 해석할 수 없는 커서
        };
        let mut stmt = conn.prepare_cached(&sql)?;
        let mut mails: Vec<MailSummary> = stmt
            .query_map(params_from_iter(binds), summary_from_row)?
            .collect::<Result<_, _>>()?;
        drop(stmt);

        let limit = req.limit.clamp(1, MAX_PAGE) as usize;
        let next_cursor = if mails.len() > limit {
            mails.truncate(limit);
            mails.last().map(|m| encode_cursor(req.sort, m))
        } else {
            None
        };

        // 첫 페이지에서만 전체 건수를 센다. 다음 페이지에서는 UI가 처음 값을 그대로 쓴다.
        let (total, older_count) = if req.cursor.is_none() {
            let n = matched;
            let older = if req.query.after.is_some() {
                Some(count(true)?.min(COUNT_CAP))
            } else {
                None
            };
            (n, older)
        } else {
            (0, None)
        };
        Ok(SearchPage {
            mails,
            total: total.min(COUNT_CAP),
            total_capped: total > COUNT_CAP,
            older_count,
            next_cursor,
        })
    }

    /// `search_page` 첫 페이지의 메일만. 테스트용 간편 호출.
    #[cfg(test)]
    pub fn search_mails_sorted(
        &self,
        account_id: Option<&str>,
        query: &str,
        sort: MailSort,
    ) -> Result<Vec<MailSummary>, StoreError> {
        let parsed = ParsedQuery::parse(query, 0);
        Ok(self
            .search_page(&SearchRequest {
                account_id,
                query: &parsed,
                sort,
                cursor: None,
                limit: MAX_PAGE,
            })?
            .mails)
    }

    #[cfg(test)]
    pub fn search_mails(
        &self,
        account_id: Option<&str>,
        query: &str,
    ) -> Result<Vec<MailSummary>, StoreError> {
        self.search_mails_sorted(account_id, query, MailSort::default())
    }

    /// 보낸사람 추천. `prefix`가 비면 메일이 많은 순. 내 주소는 뺀다.
    pub fn suggest_senders(
        &self,
        account_id: Option<&str>,
        prefix: &str,
        limit: u32,
    ) -> Result<Vec<SenderSuggestion>, StoreError> {
        let conn = self.read_lock()?;
        let like = format!("%{}%", escape_like(prefix.trim()));
        let mut stmt = conn.prepare_cached(
            "SELECT s.account_id, s.name, s.sender_email, s.mail_count
             FROM sender_stats s
             WHERE (?1 IS NULL OR s.account_id = ?1)
               AND (s.sender_email LIKE ?2 ESCAPE '\\' OR s.name LIKE ?2 ESCAPE '\\')
               AND NOT EXISTS (SELECT 1 FROM accounts a WHERE lower(a.email) = lower(s.sender_email))
             ORDER BY s.mail_count DESC, s.sender_email
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![account_id, like, i64::from(limit.clamp(1, 20))],
            |r| {
                Ok(SenderSuggestion {
                    account_id: r.get(0)?,
                    name: r.get(1)?,
                    email: r.get(2)?,
                    mail_count: r.get(3)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 성능 점검용: 검색 SQL의 `EXPLAIN QUERY PLAN` 줄들.
    #[cfg(test)]
    pub fn explain_search(
        &self,
        req: &SearchRequest<'_>,
        strategy: Strategy,
    ) -> Result<Vec<String>, StoreError> {
        let Some((sql, binds)) = page_sql(req, strategy) else {
            return Ok(Vec::new());
        };
        let conn = self.read_lock()?;
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
        let rows = stmt.query_map(params_from_iter(binds), |r| r.get::<_, String>(3))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    #[cfg(test)]
    pub fn sender_count(&self, account_id: &str, email: &str) -> Result<Option<u32>, StoreError> {
        use rusqlite::OptionalExtension;
        Ok(self
            .lock()?
            .query_row(
                "SELECT mail_count FROM sender_stats WHERE account_id = ?1 AND sender_email = ?2",
                [account_id, email],
                |r| r.get(0),
            )
            .optional()?)
    }
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod perf;
#[cfg(test)]
mod tests;
