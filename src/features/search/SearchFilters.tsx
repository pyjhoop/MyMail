import { ChevronDown, Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Account } from "../../lib/ipc";
import {
  activeFilters,
  formatDate,
  olderThanText,
  periodChipText,
  PERIODS,
  removePeriod,
  removeSender,
  setPeriod,
  toggleAttachment,
} from "./filters";
import styles from "./SearchFilters.module.css";

interface Props {
  /** 검색창 입력 전체 (연산자 포함) */
  query: string;
  onQueryChange: (next: string) => void;
  /** "보낸사람" 칩: 검색창에 `from:`을 넣고 이어서 쓰게 한다 */
  onRequestSender: () => void;
  accounts: readonly Account[];
  /** 현재 검색 범위. null이면 모든 계정 */
  scopeAccountId: string | null;
  onScopeChange: (accountId: string | null) => void;
  now?: Date;
}

/** 눌러서 고르는 작은 메뉴. 밖을 누르거나 Esc를 누르면 닫는다. */
function ChipMenu({
  label,
  active = false,
  items,
  onPick,
}: {
  label: string;
  active?: boolean;
  items: { id: string; label: string; selected?: boolean }[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={rootRef} className={styles.menuWrap}>
      <button
        type="button"
        className={`ib ${styles.chip} ${active ? styles.chipActive : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <ChevronDown size={12} strokeWidth={2} aria-hidden />
      </button>
      {open && (
        <div role="listbox" aria-label={label} className={styles.menu}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.selected ?? false}
              className={`${styles.option} ${item.selected ? styles.optionSelected : ""}`}
              onClick={() => {
                setOpen(false);
                onPick(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ActiveChip({
  text,
  removeLabel,
  onRemove,
}: {
  text: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <span className={`${styles.chip} ${styles.chipActive} ${styles.removable}`}>
      {text}
      <button type="button" className={styles.remove} aria-label={removeLabel} onClick={onRemove}>
        <X size={12} strokeWidth={2.25} aria-hidden />
      </button>
    </span>
  );
}

/** 결과 목록 위 필터 칩 줄: 보낸사람 · 기간 · 첨부 있음 · 계정. */
export function SearchFilters({
  query,
  onQueryChange,
  onRequestSender,
  accounts,
  scopeAccountId,
  onScopeChange,
  now = new Date(),
}: Props) {
  const filters = activeFilters(query);
  const period = periodChipText(filters, now);
  const scopeName = accounts.find((a) => a.id === scopeAccountId)?.name;

  return (
    <div className={styles.row} role="group" aria-label="검색 필터">
      {filters.from.length > 0 ? (
        filters.from.map((f) => (
          <ActiveChip
            key={f}
            text={`보낸사람: ${f}`}
            removeLabel={`보낸사람 ${f} 필터 해제`}
            onRemove={() => onQueryChange(removeSender(query, f))}
          />
        ))
      ) : (
        <button type="button" className={`ib ${styles.chip}`} onClick={onRequestSender}>
          보낸사람
        </button>
      )}
      {period ? (
        <ActiveChip
          text={`기간: ${period}`}
          removeLabel="기간 필터 해제"
          onRemove={() => onQueryChange(removePeriod(query))}
        />
      ) : (
        <ChipMenu
          label="기간"
          items={PERIODS.map((p) => ({ id: p.id, label: p.label }))}
          onPick={(id) => {
            const p = PERIODS.find((x) => x.id === id);
            if (p) onQueryChange(setPeriod(query, formatDate(p.start(now))));
          }}
        />
      )}
      <button
        type="button"
        className={`ib ${styles.chip} ${filters.hasAttachment ? styles.chipActive : ""}`}
        aria-pressed={filters.hasAttachment}
        onClick={() => onQueryChange(toggleAttachment(query, !filters.hasAttachment))}
      >
        <Paperclip size={12} strokeWidth={2.25} aria-hidden />
        첨부 있음
      </button>
      <ChipMenu
        label={`계정: ${scopeName ?? "전체"}`}
        active={scopeAccountId !== null}
        items={[
          { id: "", label: "전체", selected: scopeAccountId === null },
          ...accounts.map((a) => ({ id: a.id, label: a.name, selected: a.id === scopeAccountId })),
        ]}
        onPick={(id) => onScopeChange(id === "" ? null : id)}
      />
    </div>
  );
}

/** 목록 맨 아래: 기간 밖에 남은 결과가 있을 때 */
export function OlderNote({
  query,
  olderCount,
  onQueryChange,
  now = new Date(),
}: {
  query: string;
  olderCount: number | undefined;
  onQueryChange: (next: string) => void;
  now?: Date;
}) {
  const { after } = activeFilters(query);
  if (!after || !olderCount) return null;
  return (
    <p className={styles.older}>
      {olderThanText(after, now)} 결과 {olderCount.toLocaleString("ko-KR")}개 더 있음 ·{" "}
      <button
        type="button"
        className={styles.olderLink}
        onClick={() => onQueryChange(removePeriod(query))}
      >
        기간 필터 해제
      </button>
    </p>
  );
}
