import {
  Archive,
  ChevronDown,
  ChevronRight,
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
import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { Account, Folder, FolderKind } from "../../lib/ipc";
import { labelColorVar, labelPaths } from "../../lib/labels";
import { LabelContextMenu, LabelManage, type LabelManageTarget } from "../labels/LabelManage";
import styles from "./FolderPane.module.css";
import { useCollapsedFolders } from "./useCollapsedFolders";

interface Props {
  /** null이면 통합 받은편지함 */
  account: Account | null;
  accounts: Account[];
  folders: Folder[];
  selectedId: string;
  collapsed: boolean;
  onSelect: (folderId: string, accountId: string) => void;
  onCompose: () => void;
  /** 라벨을 만들거나 이름을 바꾸거나 지운 뒤(폴더·메일 목록을 다시 읽는다). 없으면 라벨 관리 메뉴가 없다 */
  onLabelsChanged?: () => void;
  /** 라벨 삭제 실패 같은 안내 */
  onError?: (message: string) => void;
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
  tree,
  onSelect,
  onContextMenu,
}: {
  folder: Folder;
  selected: boolean;
  collapsed: boolean;
  /** 라벨의 전체 이름("부모/자식"). 색을 메일 행의 라벨 칩과 맞추는 데 쓴다 */
  labelPath?: string;
  /** 자식이 있는 항목이면 접기 상태와 토글. 접힌 줄의 안 읽은 수는 자식 합계다 */
  tree?: { expanded: boolean; onToggle: (collapse: boolean) => void; unread: number };
  onSelect: () => void;
  onContextMenu?: (e: MouseEvent) => void;
}) {
  const Icon = ICONS[folder.kind] ?? Archive;
  const isInbox = folder.kind === "inbox";
  const depth = folder.depth ?? 0;
  const nested = depth > 0;
  const parent = tree !== undefined && !collapsed;
  const unread = tree && !tree.expanded ? tree.unread : folder.unread;
  const className = [
    styles.item,
    selected ? styles.selected : "",
    nested ? styles.nested : "",
    parent ? styles.parent : "",
  ].join(" ");
  const button = (
    <button
      type="button"
      className={className}
      aria-current={selected}
      aria-expanded={parent ? tree.expanded : undefined}
      title={collapsed ? folder.name : undefined}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (!parent) return;
        if (e.key === "ArrowRight" && !tree.expanded) {
          e.preventDefault();
          tree.onToggle(false);
        } else if (e.key === "ArrowLeft" && tree.expanded) {
          e.preventDefault();
          tree.onToggle(true);
        }
      }}
      style={nested ? ({ "--depth": depth } as CSSProperties) : undefined}
    >
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
          {unread > 0 && (
            <span className={isInbox || selected ? styles.countStrong : styles.count}>
              {unread}
            </span>
          )}
        </>
      )}
    </button>
  );
  if (!parent) return button;
  return (
    <div
      className={`${styles.treeRow} ${nested ? styles.nested : ""}`}
      style={nested ? ({ "--depth": depth } as CSSProperties) : undefined}
    >
      {button}
      <button
        type="button"
        className={styles.toggle}
        aria-label={`${folder.name} ${tree.expanded ? "접기" : "펼치기"}`}
        aria-expanded={tree.expanded}
        onClick={() => tree.onToggle(tree.expanded)}
      >
        {tree.expanded ? (
          <ChevronDown size={14} strokeWidth={2} aria-hidden />
        ) : (
          <ChevronRight size={14} strokeWidth={2} aria-hidden />
        )}
      </button>
    </div>
  );
}

/**
 * 깊이(depth)로 부모/자식을 나타내는 목록(서버 순서, 부모가 자식보다 앞)을 접고 펼 수 있게 그린다.
 * 선택된 항목의 조상은 접혀 있어도 펼친 것으로 본다.
 */
function FolderTree({
  items,
  selectedId,
  collapsed,
  collapsedIds,
  onToggle,
  paths,
  onSelect,
  onContextMenu,
}: {
  items: Folder[];
  selectedId: string;
  collapsed: boolean;
  collapsedIds: ReadonlySet<string>;
  onToggle: (id: string, collapse: boolean) => void;
  paths?: Map<string, string>;
  onSelect: (id: string) => void;
  onContextMenu?: (folder: Folder, e: MouseEvent) => void;
}) {
  const depthOf = (f: Folder) => f.depth ?? 0;
  const forcedOpen = new Set<string>();
  const selectedIndex = items.findIndex((f) => f.id === selectedId);
  if (selectedIndex >= 0) {
    let need = depthOf(items[selectedIndex]);
    for (let i = selectedIndex - 1; i >= 0 && need > 0; i--) {
      if (depthOf(items[i]) < need) {
        forcedOpen.add(items[i].id);
        need = depthOf(items[i]);
      }
    }
  }

  const rows: ReactNode[] = [];
  let hideBelow: number | null = null; // 이 깊이보다 깊은 항목은 접힌 부모 안이라 숨긴다
  items.forEach((f, i) => {
    const depth = depthOf(f);
    if (hideBelow !== null) {
      if (depth > hideBelow) return;
      hideBelow = null;
    }
    let total = f.unread;
    let hasChildren = false;
    for (let j = i + 1; j < items.length && depthOf(items[j]) > depth; j++) {
      hasChildren = true;
      total += items[j].unread;
    }
    const expanded = !hasChildren || collapsed || !collapsedIds.has(f.id) || forcedOpen.has(f.id);
    if (hasChildren && !expanded) hideBelow = depth;
    rows.push(
      <FolderItem
        key={f.id}
        folder={f}
        labelPath={paths?.get(f.id)}
        selected={f.id === selectedId}
        collapsed={collapsed}
        tree={
          hasChildren
            ? { expanded, onToggle: (collapse) => onToggle(f.id, collapse), unread: total }
            : undefined
        }
        onSelect={() => onSelect(f.id)}
        onContextMenu={onContextMenu && ((e) => onContextMenu(f, e))}
      />,
    );
  });
  return <>{rows}</>;
}

export function FolderPane({
  account,
  accounts,
  folders,
  selectedId,
  collapsed,
  onSelect,
  onCompose,
  onLabelsChanged,
  onError,
}: Props) {
  const [manage, setManage] = useState<LabelManageTarget | null>(null);
  const [menu, setMenu] = useState<{ folder: Folder; x: number; y: number } | null>(null);
  const { collapsedIds, toggle: toggleCollapsed } = useCollapsedFolders(account?.id ?? "");
  const toggle = (id: string, collapse: boolean) => toggleCollapsed(id, collapse);
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
  for (const f of labels) if (f.path) paths.set(f.id, f.path);
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
          <button
            type="button"
            className={`ib ${styles.addLabel}`}
            aria-label="라벨 추가"
            onClick={() => onLabelsChanged && setManage({ kind: "create" })}
          >
            <Plus size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>
      )}
      <FolderTree
        items={labels}
        selectedId={selectedId}
        collapsed={collapsed}
        collapsedIds={collapsedIds}
        onToggle={toggle}
        paths={paths}
        onSelect={(id) => onSelect(id, account.id)}
        onContextMenu={
          onLabelsChanged
            ? (folder, e) => {
                e.preventDefault();
                setMenu({ folder, x: e.clientX, y: e.clientY });
              }
            : undefined
        }
      />
      <FolderTree
        items={custom}
        selectedId={selectedId}
        collapsed={collapsed}
        collapsedIds={collapsedIds}
        onToggle={toggle}
        onSelect={(id) => onSelect(id, account.id)}
      />
      {menu && (
        <LabelContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() =>
            setManage({
              kind: "rename",
              folder: menu.folder,
              path: paths.get(menu.folder.id) ?? menu.folder.name,
            })
          }
          onDelete={() =>
            setManage({
              kind: "delete",
              folder: menu.folder,
              path: paths.get(menu.folder.id) ?? menu.folder.name,
            })
          }
        />
      )}
      {manage && (
        <LabelManage
          accountId={account.id}
          target={manage}
          onClose={() => setManage(null)}
          onDone={() => onLabelsChanged?.()}
          onError={(m) => onError?.(m)}
        />
      )}
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
