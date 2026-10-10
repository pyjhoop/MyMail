import type { Account, ScopeCount } from "../../lib/ipc";
import folder from "../folders/FolderPane.module.css";
import styles from "./SearchScope.module.css";

interface Props {
  accounts: readonly Account[];
  /** 계정별 일치 건수. 아직 못 받았으면 undefined(건수 자리를 비운다) */
  counts: readonly ScopeCount[] | undefined;
  /** 현재 범위. null이면 모든 계정 */
  selectedId: string | null;
  collapsed: boolean;
  onSelect: (accountId: string | null) => void;
}

function countText(c: { count: number; capped: boolean } | undefined): string {
  if (!c) return "";
  return `${c.count.toLocaleString("ko-KR")}${c.capped ? "+" : ""}`;
}

/** 검색 결과 화면의 폴더 패널 자리: 계정별 결과 수로 검색 범위를 고른다. */
export function SearchScope({ accounts, counts, selectedId, collapsed, onSelect }: Props) {
  const byAccount = new Map(counts?.map((c) => [c.accountId, c]));
  const total = counts
    ? {
        count: counts.reduce((n, c) => n + c.count, 0),
        capped: counts.some((c) => c.capped),
      }
    : undefined;
  const unread = accounts.reduce((n, a) => n + a.unread, 0);

  const entries = [
    { id: null, name: "모든 계정", color: "var(--color-text)", count: total },
    ...accounts.map((a) => ({
      id: a.id,
      name: a.name,
      color: `var(--account-${a.colorIndex})`,
      count: byAccount.get(a.id),
    })),
  ];

  return (
    <aside className={`${folder.pane} ${collapsed ? folder.collapsed : ""}`} aria-label="검색 범위">
      {!collapsed && (
        <div className={folder.head}>
          <div className={folder.title}>전체</div>
          <div className={folder.sub}>
            계정 {accounts.length}개 · 안 읽음 {unread}
          </div>
        </div>
      )}
      {!collapsed && <div className={`${folder.section} ${styles.section}`}>검색 범위</div>}
      {entries.map((e) => (
        <button
          key={e.id ?? "all"}
          type="button"
          className={`${folder.item} ${e.id === selectedId ? folder.selected : ""}`}
          aria-current={e.id === selectedId}
          title={collapsed ? e.name : undefined}
          onClick={() => onSelect(e.id)}
        >
          <span className={styles.dotWrap}>
            <span className={styles.dot} style={{ background: e.color }} />
          </span>
          {!collapsed && (
            <>
              <span className={folder.name}>{e.name}</span>
              <span className={folder.count}>{countText(e.count)}</span>
            </>
          )}
        </button>
      ))}
      {!collapsed && (
        <p className={styles.note}>
          받은편지함·보낸편지함·보관함을 함께 찾아요. 스팸·휴지통은 제외됩니다.
        </p>
      )}
    </aside>
  );
}
