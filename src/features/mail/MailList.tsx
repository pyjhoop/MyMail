import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUpDown, Paperclip, RefreshCw, Star } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  AuthErrorState,
  EmptyFolder,
  ListSkeleton,
  LoadErrorState,
  OfflineState,
} from "../../components/StateView";
import type { Account, LoadError, MailSummary } from "../../lib/ipc";
import styles from "./MailList.module.css";

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
  onRefresh: () => void;
}

// 행 높이는 tokens.css의 --mail-row-height(84px)와 같아야 한다.
const ROW_HEIGHT = 84;

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
  onRefresh,
}: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // TanStack Virtual은 React Compiler 메모이제이션과 맞지 않지만 이 컴포넌트에서는 문제 없다.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  return (
    <section className={styles.list} aria-label="메일 목록">
      <div className={styles.head}>
        <div className={styles.headTitle}>
          <h2>{title}</h2>
          {status === "ready" && <span className={styles.unread}>안 읽음 {unreadCount}</span>}
        </div>
        <div className={styles.headActions}>
          <button type="button" className={`ib ${styles.sort}`} aria-label="정렬: 최신순">
            <ArrowUpDown size={16} strokeWidth={1.75} aria-hidden />
            최신순
          </button>
          <button
            type="button"
            className={`ib ${styles.refresh}`}
            aria-label="새로고침"
            onClick={onRefresh}
          >
            <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
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
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {status === "loading" && <ListSkeleton />}
      {status === "error" && error?.kind === "network" && <OfflineState onRetry={onRefresh} />}
      {status === "error" && error?.kind === "auth" && <AuthErrorState onRetry={onRefresh} />}
      {status === "error" && error?.kind !== "network" && error?.kind !== "auth" && (
        <LoadErrorState
          message={error?.message ?? "잠시 후 다시 시도해 주세요."}
          onRetry={onRefresh}
        />
      )}
      {status === "ready" && visible.length === 0 && <EmptyFolder />}
      {status === "ready" && visible.length > 0 && (
        <div ref={scrollRef} className={styles.scroll}>
          <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const m = visible[v.index];
              const selected = m.id === selectedId;
              const account = showAccount ? accounts.find((a) => a.id === m.accountId) : undefined;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`${styles.row} ${selected ? styles.selected : ""}`}
                  style={{ transform: `translateY(${v.start}px)` }}
                  aria-current={selected}
                  onClick={() => onSelect(m.id)}
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
                      {m.subject}
                    </span>
                    <span className={styles.line}>
                      <span className={styles.preview}>{m.preview}</span>
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
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
