//! 검색 command. 연산자 해석·페이징은 `store::search`가 한다.

use tauri::State;

use super::{invalid, parse_sort, CommandResult};
use crate::store::search::{DEFAULT_PAGE, MAX_PAGE};
use crate::store::{ParsedQuery, SearchPage, SearchRequest, SenderSuggestion, Store};

/// 제목·보낸사람·본문 검색(연산자 `from:` `to:` `has:` `is:` `after:` `before:` 지원).
/// `account_id`가 없으면 모든 계정. `cursor`는 앞 페이지가 돌려준 `nextCursor`.
/// `tz_offset_secs`는 `after:`/`before:` 날짜를 해석할 시간대(UTC와의 차이, 초).
#[tauri::command]
pub async fn search_mails(
    store: State<'_, Store>,
    account_id: Option<String>,
    query: String,
    sort: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
    tz_offset_secs: Option<i64>,
) -> CommandResult<SearchPage> {
    let sort = parse_sort(sort.as_deref())?;
    let tz = tz_offset_secs.unwrap_or(0);
    if !(-14 * 3600..=14 * 3600).contains(&tz) {
        return Err(invalid("시간대가 올바르지 않아요."));
    }
    let parsed = ParsedQuery::parse(&query, tz);
    let req = SearchRequest {
        account_id: account_id.as_deref(),
        query: &parsed,
        sort,
        cursor: cursor.as_deref(),
        limit: limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE),
    };
    // 디스크를 읽는 동안 비동기 작업자 하나를 점유하므로 블로킹 구간으로 표시한다.
    Ok(tokio::task::block_in_place(|| store.search_page(&req))?)
}

/// 보낸사람 추천. 동기화 때 갱신되는 집계 테이블을 읽는다.
#[tauri::command]
pub async fn suggest_senders(
    store: State<'_, Store>,
    account_id: Option<String>,
    prefix: Option<String>,
    limit: Option<u32>,
) -> CommandResult<Vec<SenderSuggestion>> {
    Ok(tokio::task::block_in_place(|| {
        store.suggest_senders(
            account_id.as_deref(),
            prefix.as_deref().unwrap_or(""),
            limit.unwrap_or(5),
        )
    })?)
}
