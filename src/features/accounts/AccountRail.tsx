import { Layers, Plus, Settings } from "lucide-react";
import type { CSSProperties } from "react";
import type { Account } from "../../lib/ipc";
import styles from "./AccountRail.module.css";

export type AccountSelection = "all" | string;

interface Props {
  accounts: Account[];
  selected: AccountSelection;
  onSelect: (id: AccountSelection) => void;
  onAddAccount: () => void;
  onOpenSettings: () => void;
}

const badgeText = (n: number) => (n > 99 ? "99+" : String(n));

export function AccountRail({ accounts, selected, onSelect, onAddAccount, onOpenSettings }: Props) {
  const total = accounts.reduce((sum, a) => sum + a.unread, 0);

  return (
    <nav className={styles.rail} aria-label="계정">
      <div className={styles.slot}>
        {selected === "all" && <span className={styles.indicator} />}
        <button
          type="button"
          className={`ib ${styles.all}`}
          aria-label="전체 받은편지함"
          aria-current={selected === "all"}
          onClick={() => onSelect("all")}
        >
          <Layers size={20} strokeWidth={1.75} aria-hidden />
          {total > 0 && (
            <span className={`${styles.badge} ${styles.allBadge}`}>{badgeText(total)}</span>
          )}
        </button>
      </div>
      <span className={styles.divider} />

      {accounts.map((a) => {
        const isSelected = selected === a.id;
        return (
          <div className={styles.slot} key={a.id}>
            {isSelected && <span className={styles.indicator} />}
            <button
              type="button"
              className={styles.avatar}
              style={{ "--ring": `var(--account-${a.colorIndex})` } as CSSProperties}
              aria-label={`${a.name} · ${a.email}${isSelected ? " (선택됨)" : ""}`}
              aria-current={isSelected}
              title={`${a.name} · ${a.email}`}
              onClick={() => onSelect(a.id)}
            >
              {a.initial}
              {a.unread > 0 && <span className={styles.badge}>{badgeText(a.unread)}</span>}
              <span className={styles.provider} aria-hidden>
                {a.provider === "gmail" ? "G" : "N"}
              </span>
            </button>
          </div>
        );
      })}

      <div className={styles.spacer} />
      <button
        type="button"
        className={`ib ${styles.add}`}
        aria-label="계정 추가"
        onClick={onAddAccount}
      >
        <Plus size={20} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        className={`ib ${styles.settings}`}
        aria-label="설정"
        onClick={onOpenSettings}
      >
        <Settings size={20} strokeWidth={1.75} aria-hidden />
      </button>
    </nav>
  );
}
