import { Clock, X } from "lucide-react";
import { TIPS, TIP_INSERT } from "./query";
import styles from "./SearchSuggest.module.css";

export interface RecentOption {
  /** 저장된 검색 전체 */
  query: string;
  /** 연산자를 뺀 검색어 */
  text: string;
  /** 연산자 토큰들 (`from:한결카드` 등) */
  operators: string[];
}

export interface SenderOption {
  accountId: string;
  name: string;
  email: string;
  mailCount: number;
  /** 계정 색 (1~8). 계정을 못 찾으면 없음 */
  colorIndex?: number;
}

interface Props {
  id: string;
  recent: RecentOption[];
  senders: SenderOption[];
  /** 최근 검색 다음에 보낸사람이 이어지는 하나의 목록에서 고른 항목 (-1이면 없음) */
  activeIndex: number;
  onPickRecent: (query: string) => void;
  onRemoveRecent: (query: string) => void;
  onPickSender: (sender: SenderOption) => void;
  onPickTip: (tip: string) => void;
  onHover: (index: number) => void;
}

export function SearchSuggest({
  id,
  recent,
  senders,
  activeIndex,
  onPickRecent,
  onRemoveRecent,
  onPickSender,
  onPickTip,
  onHover,
}: Props) {
  // 입력창에 포커스를 둔 채 마우스로 고르게 하려고 누르는 순간의 포커스 이동을 막는다.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className={styles.popup} onMouseDown={keepFocus}>
      <div id={id} role="listbox" aria-label="검색 추천">
        {recent.length > 0 && (
          <div className={styles.section}>
            <div className={styles.heading}>최근 검색</div>
            {recent.map((r, i) => (
              <div
                key={r.query}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={activeIndex === i}
                className={`${styles.recent} ${activeIndex === i ? styles.active : ""}`}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPickRecent(r.query)}
              >
                <Clock size={16} strokeWidth={1.75} aria-hidden className={styles.icon} />
                <span className={styles.grow}>
                  {r.text}
                  {r.operators.map((op) => (
                    <code key={op} className={styles.op}>
                      {op}
                    </code>
                  ))}
                </span>
                <span className={styles.hint}>Enter</span>
                <button
                  type="button"
                  className={`ib ${styles.remove}`}
                  aria-label={`최근 검색에서 삭제: ${r.query}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveRecent(r.query);
                  }}
                >
                  <X size={14} strokeWidth={2} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}
        {senders.length > 0 && (
          <div className={`${styles.section} ${recent.length > 0 ? styles.divided : ""}`}>
            <div className={styles.heading}>보낸사람</div>
            {senders.map((s, j) => {
              const i = recent.length + j;
              return (
                <div
                  key={`${s.accountId}-${s.email}`}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={activeIndex === i}
                  className={`${styles.person} ${activeIndex === i ? styles.active : ""}`}
                  onMouseEnter={() => onHover(i)}
                  onClick={() => onPickSender(s)}
                >
                  <span className={styles.avatar} aria-hidden>
                    {s.name.slice(0, 1) || s.email.slice(0, 1)}
                  </span>
                  <span className={styles.name}>{s.name}</span>
                  <span className={`${styles.grow} ${styles.email}`}>{s.email}</span>
                  <span className={styles.count}>
                    {s.colorIndex !== undefined && (
                      <span
                        className={styles.dot}
                        style={{ background: `var(--account-${s.colorIndex})` }}
                      />
                    )}
                    메일 {s.mailCount}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className={`${styles.tips} ${recent.length + senders.length > 0 ? styles.divided : ""}`}>
        <span className={styles.tipsLabel}>검색어 팁</span>
        {TIPS.map((tip) => (
          <button
            key={tip}
            type="button"
            className={styles.tip}
            tabIndex={-1}
            onClick={() => onPickTip(TIP_INSERT[tip] ?? tip)}
          >
            {tip}
          </button>
        ))}
      </div>
      <div className={styles.keys}>
        <span>↑↓ 이동</span>
        <span>Enter 검색</span>
        <span>Tab 보낸사람 필터로</span>
        <span className={styles.grow} />
        <span>Esc 닫기</span>
      </div>
    </div>
  );
}
