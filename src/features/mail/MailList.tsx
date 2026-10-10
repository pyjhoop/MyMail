import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUpDown, Check, Paperclip, RefreshCw, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  AuthErrorState,
  EmptyFolder,
  ListSkeleton,
  LoadErrorState,
  NoSearchResults,
  OfflineState,
} from "../../components/StateView";
import type { Account, LoadError, MailSort, MailSummary } from "../../lib/ipc";
import { Highlight } from "../search/Highlight";
import styles from "./MailList.module.css";
import { SORT_OPTIONS, sortLabel } from "./sort";

export type ListStatus = "loading" | "ready" | "error";
type Filter = "all" | "unread" | "starred";

interface Props {
  title: string;
  status: ListStatus;
  error?: LoadError;
  mails: MailSummary[];
  accounts: Account[];
  /** 통합 보기에서는 행에 계정 색 점을 붙인다 */
  showAccount: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 체크박스·Ctrl+클릭·Shift+클릭으로 고른 메일들 (본문을 여는 selectedId와 별개) */
  checkedIds: ReadonlySet<string>;
  onCheckedChange: (ids: Set<string>) => void;
  onDelete: () => void;
  deleting?: boolean;
  /** 삭제 결과 등 목록 위에 보여줄 안내 */
  notice?: string;
  /** 검색 결과를 보여 주는 중이면 빈 목록 문구가 달라진다 */
  searching?: boolean;
  /** 검색 결과에서 제목·미리보기에 강조할 단어 */
  highlight?: readonly string[];
  /** 목록 끝 가까이까지 스크롤했을 때(검색 결과의 다음 페이지를 이어 받는다) */
  onEndReached?: () => void;
  /** 새로고침 = 서버 동기화. 오류 화면의 "다시 시도"도 같은 함수를 부른다 */
  onRefresh: () => void;
  /** 동기화 중이면 버튼을 돌리고 비활성화한다 */
  refreshing?: boolean;
  /** 동기화 실패 안내 */
  syncError?: string;
  lastSyncedAt?: Date | null;
  sort: MailSort;
  onSortChange: (sort: MailSort) => void;
}

// 행 높이는 tokens.css의 --mail-row-height(84px)와 같아야 한다.
const ROW_HEIGHT = 84;
const NO_TERMS: readonly string[] = [];
/** 끝에서 이만큼 남으면 다음 페이지를 부른다 */
const END_MARGIN = 10;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "unread", label: "안 읽음" },
  { id: "starred", label: "별표" },
];

export function MailList({
  title,
  status,
  error,
  mails,
  accounts,
  showAccount,
  selectedId,
  onSelect,
  checkedIds,
  onCheckedChange,
  onDelete,
  deleting = false,
  notice,
  searching = false,
  highlight = NO_TERMS,
  onEndReached,
  onRefresh,
  refreshing = false,
  syncError,
  lastSyncedAt,
  sort,
  onSortChange,
}: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sortOpen, setSortOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  // 메뉴 밖을 누르거나 Esc를 누르면 닫는다.
  useEffect(() => {
    if (!sortOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!sortMenuRef.current?.contains(e.target as Node)) setSortOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSortOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sortOpen]);

  /** 정렬을 바꾸면 스크롤을 맨 위로 돌린다. 선택·체크 상태는 그대로 둔다. */
  const chooseSort = (next: MailSort) => {
    setSortOpen(false);
    if (next === sort) return;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    onSortChange(next);
  };
  /** Shift+클릭 범위의 시작점. 가상화로 행이 사라져도 id로 기억한다. */
  const anchorId = useRef<string | null>(null);

  const unreadCount = useMemo(() => mails.filter((m) => m.unread).length, [mails]);
  const visible = useMemo(
    () =>
      filter === "unread"
        ? mails.filter((m) => m.unread)
        : filter === "starred"
          ? mails.filter((m) => m.starred)
          : mails,
    [mails, filter],
  );

  const changeFilter = (next: Filter) => {
    setFilter(next);
    // 필터로 가려진 메일이 선택에 남아 같이 지워지는 일을 막는다.
    if (checkedIds.size > 0) onCheckedChange(new Set());
  };

  /** 선택만 바꾸는 클릭이면 선택을 갱신하고, 평범한 클릭이면 본문을 연다 */
  const pick = (id: string, e: MouseEvent, fromCheckbox: boolean) => {
    const additive = e.ctrlKey || e.metaKey || fromCheckbox;
    if (!e.shiftKey && !additive) {
      if (checkedIds.size > 0) onCheckedChange(new Set());
      anchorId.current = id;
      onSelect(id);
      return;
    }
    const next = new Set(e.shiftKey && !additive ? [] : checkedIds);
    const from = visible.findIndex((m) => m.id === (anchorId.current ?? selectedId));
    if (e.shiftKey && from >= 0) {
      const to = visible.findIndex((m) => m.id === id);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(visible[i].id);
    } else {
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchorId.current = id;
    }
    onCheckedChange(next);
  };

  // TanStack Virtual은 React Compiler 메모이제이션과 맞지 않지만 이 컴포넌트에서는 문제 없다.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastShown = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  useEffect(() => {
    if (onEndReached && lastShown >= 0 && lastShown >= visible.length - END_MARGIN) onEndReached();
  }, [onEndReached, lastShown, visible.length]);

  return (
    <section className={styles.list} aria-label="메일 목록">
      <div className={styles.head}>
        <div className={styles.headTitle}>
          <h2>{title}</h2>
          {status === "ready" && <span className={styles.unread}>안 읽음 {unreadCount}</span>}
        </div>
        <div className={styles.headActions}>
          {checkedIds.size > 0 && (
            <span className={styles.checkedCount}>선택 {checkedIds.size}개</span>
          )}
          <button
            type="button"
            className={`ib ${styles.delete}`}
            aria-label="삭제"
            disabled={checkedIds.size === 0 || deleting}
            onClick={onDelete}
          >
            <Trash2 size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <div className={styles.sortWrap} ref={sortMenuRef}>
            <button
              type="button"
              className={`ib ${styles.sort}`}
              aria-label={`정렬: ${sortLabel(sort)}`}
              aria-haspopup="menu"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen((open) => !open)}
            >
              <ArrowUpDown size={16} strokeWidth={1.75} aria-hidden />
              {sortLabel(sort)}
            </button>
            {sortOpen && (
              <div role="menu" aria-label="정렬 기준" className={styles.sortMenu}>
                {SORT_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sort === o.id}
                    className={`${styles.sortItem} ${sort === o.id ? styles.sortItemActive : ""}`}
                    onClick={() => chooseSort(o.id)}
                  >
                    <Check size={16} strokeWidth={1.75} aria-hidden className={styles.sortCheck} />
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className={`ib ${styles.refresh}`}
            aria-label="새로고침"
            title={
              lastSyncedAt
                ? `새로고침 · 마지막 동기화 ${lastSyncedAt.toLocaleTimeString("ko-KR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}`
                : "새로고침"
            }
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw
              size={16}
              strokeWidth={1.75}
              aria-hidden
              className={refreshing ? styles.spin : undefined}
            />
          </button>
        </div>
      </div>

      <div role="tablist" aria-label="필터" className={styles.tabs}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`ib ${styles.tab} ${filter === f.id ? styles.tabActive : ""}`}
            onClick={() => changeFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {notice && (
        <div className={styles.notice} role="alert">
          {notice}
        </div>
      )}

      {syncError && (
        <div className={styles.notice} role="alert">
          {syncError}
        </div>
      )}

      {status === "loading" && <ListSkeleton />}
      {status === "error" && error?.kind === "network" && <OfflineState onRetry={onRefresh} />}
      {status === "error" && error?.kind === "auth" && <AuthErrorState onRetry={onRefresh} />}
      {status === "error" && error?.kind !== "network" && error?.kind !== "auth" && (
        <LoadErrorState
          message={error?.message ?? "잠시 후 다시 시도해 주세요."}
          onRetry={onRefresh}
        />
      )}
      {status === "ready" &&
        visible.length === 0 &&
        (searching ? <NoSearchResults /> : <EmptyFolder />)}
      {status === "ready" && visible.length > 0 && (
        <div ref={scrollRef} className={styles.scroll}>
          <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const m = visible[v.index];
              const selected = m.id === selectedId;
              const checked = checkedIds.has(m.id);
              const account = showAccount ? accounts.find((a) => a.id === m.accountId) : undefined;
              return (
                <div
                  key={m.id}
                  className={`${styles.row} ${selected || checked ? styles.selected : ""} ${
                    checkedIds.size > 0 ? styles.selecting : ""
                  }`}
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  <input
                    type="checkbox"
                    className={styles.check}
                    aria-label={`${m.sender} - ${m.subject} 선택`}
                    checked={checked}
                    onChange={() => undefined}
                    onClick={(e) => pick(m.id, e, true)}
                  />
                  <button
                    type="button"
                    className={styles.main}
                    aria-current={selected}
                    onClick={(e) => pick(m.id, e, false)}
                  >
                    <span className={styles.gutter}>
                      {m.unread && <span className={styles.dot} aria-label="안 읽음" />}
                    </span>
                    <span className={styles.body}>
                      <span className={styles.line}>
                        <span className={`${styles.sender} ${m.unread ? styles.strong : ""}`}>
                          {account && (
                            <span
                              className={styles.accountDot}
                              style={{ background: `var(--account-${account.colorIndex})` }}
                              title={account.name}
                            />
                          )}
                          {m.sender}
                          {m.threadCount && (
                            <span className={styles.threadCount}>{m.threadCount}</span>
                          )}
                        </span>
                        <span className={styles.time}>{m.time}</span>
                      </span>
                      <span className={`${styles.subject} ${m.unread ? styles.strong : ""}`}>
                        <Highlight text={m.subject} terms={highlight} />
                      </span>
                      <span className={styles.line}>
                        <span className={styles.preview}>
                          <Highlight text={m.preview} terms={highlight} />
                        </span>
                        {m.label && (
                          <span className={styles.chip}>
                            <span
                              className={styles.chipDot}
                              style={{ background: `var(--account-${m.label.colorIndex})` }}
                            />
                            {m.label.name}
                          </span>
                        )}
                        {m.hasAttachment && (
                          <Paperclip
                            size={16}
                            strokeWidth={1.75}
                            className={styles.meta}
                            aria-label="첨부 있음"
                          />
                        )}
                        {m.starred && (
                          <Star
                            size={16}
                            strokeWidth={1.75}
                            fill="currentColor"
                            className={styles.star}
                            aria-label="별표"
                          />
                        )}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
