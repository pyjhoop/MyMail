import {
  Archive,
  ChevronDown,
  FileText,
  Folder as FolderIcon,
  Inbox,
  OctagonAlert,
  PenSquare,
  Plus,
  Send,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import type { Account, Folder, FolderKind } from "../../lib/ipc";
import { labelColorVar, labelPaths } from "../../lib/labels";
import styles from "./FolderPane.module.css";

interface Props {
  /** null이면 통합 받은편지함 */
  account: Account | null;
  accounts: Account[];
  folders: Folder[];
  selectedId: string;
  collapsed: boolean;
  onSelect: (folderId: string, accountId: string) => void;
  onCompose: () => void;
}

const ICONS: Partial<Record<FolderKind, LucideIcon>> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  spam: OctagonAlert,
  trash: Trash2,
  folder: FolderIcon,
  archive: Archive,
};

const SYSTEM: FolderKind[] = ["inbox", "sent", "drafts", "spam", "trash"];

function FolderItem({
  folder,
  selected,
  collapsed,
  labelPath,
  onSelect,
}: {
  folder: Folder;
  selected: boolean;
  collapsed: boolean;
  /** 라벨의 전체 이름("부모/자식"). 색을 메일 행의 라벨 칩과 맞추는 데 쓴다 */
  labelPath?: string;
  onSelect: () => void;
}) {
  const Icon = ICONS[folder.kind] ?? Archive;
  const isInbox = folder.kind === "inbox";
  const nested = (folder.depth ?? 0) > 0;
  return (
    <button
      type="button"
      className={`${styles.item} ${selected ? styles.selected : ""}`}
      aria-current={selected}
      title={collapsed ? folder.name : undefined}
      onClick={onSelect}
      style={nested ? ({ "--indent": "38px" } as CSSProperties) : undefined}
    >
      {folder.expandable && <ChevronDown size={14} strokeWidth={2} aria-hidden />}
      {folder.kind === "label" ? (
        <span className={styles.dotWrap}>
          <span
            className={styles.dot}
            style={{ background: labelColorVar(labelPath ?? folder.name) }}
          />
        </span>
      ) : (
        !nested && <Icon size={20} strokeWidth={1.75} aria-hidden />
      )}
      {!collapsed && (
        <>
          <span className={styles.name}>{folder.name}</span>
          {folder.unread > 0 && (
            <span className={isInbox || selected ? styles.countStrong : styles.count}>
              {folder.unread}
            </span>
          )}
        </>
      )}
    </button>
  );
}

export function FolderPane({
  account,
  accounts,
  folders,
  selectedId,
  collapsed,
  onSelect,
  onCompose,
}: Props) {
  if (account === null) {
    // 통합 받은편지함: 계정별 받은편지함 목록
    const total = accounts.reduce((sum, a) => sum + a.unread, 0);
    return (
      <aside className={`${styles.pane} ${collapsed ? styles.collapsed : ""}`} aria-label="폴더">
        {!collapsed && (
          <div className={styles.head}>
            <div className={styles.title}>통합 받은편지함</div>
            <div className={styles.sub}>
              계정 {accounts.length}개 · 안 읽음 {total}
            </div>
          </div>
        )}
        <ComposeButton collapsed={collapsed} onCompose={onCompose} />
        {!collapsed && <div className={styles.section}>계정별 받은편지함</div>}
        {accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            className={styles.accountItem}
            title={collapsed ? a.name : undefined}
            onClick={() => onSelect(`${a.id}-inbox`, a.id)}
          >
            <span
              className={styles.accountDot}
              style={{ background: `var(--account-${a.colorIndex})` }}
            >
              {a.initial}
            </span>
            {!collapsed && (
              <>
                <span className={styles.accountText}>
                  <span className={styles.name}>{a.name}</span>
                  <span className={styles.sub}>{a.email}</span>
                </span>
                {a.unread > 0 && <span className={styles.count}>{a.unread}</span>}
              </>
            )}
          </button>
        ))}
      </aside>
    );
  }

  const system = folders.filter((f) => SYSTEM.includes(f.kind));
  const labels = folders.filter((f) => f.kind === "label");
  const paths = labelPaths(labels);
  const custom = folders.filter((f) => f.kind === "folder" || f.kind === "archive");

  return (
    <aside className={`${styles.pane} ${collapsed ? styles.collapsed : ""}`} aria-label="폴더">
      {!collapsed && (
        <div className={styles.head}>
          <div className={styles.title}>{account.name}</div>
          <div className={styles.sub}>{account.email}</div>
        </div>
      )}
      <ComposeButton collapsed={collapsed} onCompose={onCompose} />
      {system.map((f) => (
        <FolderItem
          key={f.id}
          folder={f}
          selected={f.id === selectedId}
          collapsed={collapsed}
          onSelect={() => onSelect(f.id, account.id)}
        />
      ))}
      {labels.length > 0 && !collapsed && (
        <div className={styles.sectionRow}>
          <span className={styles.section}>라벨</span>
          <button type="button" className={`ib ${styles.addLabel}`} aria-label="라벨 추가">
            <Plus size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>
      )}
      {labels.map((f) => (
        <FolderItem
          key={f.id}
          folder={f}
          labelPath={paths.get(f.id)}
          selected={f.id === selectedId}
          collapsed={collapsed}
          onSelect={() => onSelect(f.id, account.id)}
        />
      ))}
      {custom.map((f) => (
        <FolderItem
          key={f.id}
          folder={f}
          selected={f.id === selectedId}
          collapsed={collapsed}
          onSelect={() => onSelect(f.id, account.id)}
        />
      ))}
    </aside>
  );
}

function ComposeButton({ collapsed, onCompose }: { collapsed: boolean; onCompose: () => void }) {
  return (
    <button
      type="button"
      className={styles.compose}
      aria-label="새 메일"
      title={collapsed ? "새 메일" : undefined}
      onClick={onCompose}
    >
      <PenSquare size={18} strokeWidth={2} aria-hidden />
      {!collapsed && (
        <>
          <span className={styles.composeText}>새 메일</span>
          <kbd>C</kbd>
        </>
      )}
    </button>
  );
}
