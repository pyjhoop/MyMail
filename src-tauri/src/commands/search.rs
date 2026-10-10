//! 검색 command. 연산자 해석·페이징은 `store::search`가 한다.

use tauri::State;

use super::{invalid, parse_sort, CommandResult};
pub use crate::store::search::DEFAULT_PAGE;
use crate::store::search::MAX_PAGE;
use crate::store::{
    ParsedQuery, ScopeCount, SearchPage, SearchRequest, SenderSuggestion, Store, StoreError,
};

/// 디스크를 읽는 일을 블로킹 작업자로 넘겨 비동기 작업자(와 UI)를 막지 않는다.
pub(super) async fn blocking<T, F>(f: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, StoreError> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(result) => Ok(result?),
        Err(_) => Err(invalid("작업이 중단되었어요.")),
    }
}

fn check_tz(tz_offset_secs: Option<i64>) -> CommandResult<i64> {
    let tz = tz_offset_secs.unwrap_or(0);
    if !(-14 * 3600..=14 * 3600).contains(&tz) {
        return Err(invalid("시간대가 올바르지 않아요."));
    }
    Ok(tz)
}

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
    let tz = check_tz(tz_offset_secs)?;
    let store = store.inner().clone();
    blocking(move || {
        let parsed = ParsedQuery::parse(&query, tz);
        store.search_page(&SearchRequest {
            account_id: account_id.as_deref(),
            query: &parsed,
            sort,
            cursor: cursor.as_deref(),
            limit: limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE),
        })
    })
    .await
}

/// 계정별 일치 건수. 검색 범위 패널이 "모든 계정 N / 계정마다 N"을 보여 줄 때 쓴다.
#[tauri::command]
pub async fn search_scope_counts(
    store: State<'_, Store>,
    query: String,
    tz_offset_secs: Option<i64>,
) -> CommandResult<Vec<ScopeCount>> {
    let tz = check_tz(tz_offset_secs)?;
    let store = store.inner().clone();
    blocking(move || store.search_scope_counts(&ParsedQuery::parse(&query, tz))).await
}

/// 보낸사람 추천. 동기화 때 갱신되는 집계 테이블을 읽는다.
#[tauri::command]
pub async fn suggest_senders(
    store: State<'_, Store>,
    account_id: Option<String>,
    prefix: Option<String>,
    limit: Option<u32>,
) -> CommandResult<Vec<SenderSuggestion>> {
    let store = store.inner().clone();
    blocking(move || {
        store.suggest_senders(
            account_id.as_deref(),
            prefix.as_deref().unwrap_or(""),
            limit.unwrap_or(5),
        )
    })
    .await
}
