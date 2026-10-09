import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Folder } from "../../lib/ipc";
import styles from "./MoreMenu.module.css";

export interface MoreMenuProps {
  disabled: boolean;
  unread: boolean;
  starred: boolean;
  /** 이 메일을 옮길 수 있는 폴더(지금 폴더 제외) */
  moveTargets: Folder[];
  /** 스팸함으로 보내는 항목(스팸함이 있을 때만) / 스팸함 안의 메일이면 "스팸 아님" */
  spam?: { isSpam: boolean };
  onSetRead: (read: boolean) => void;
  onSetStarred: (starred: boolean) => void;
  onMove: (folder: Folder) => void;
  onToggleSpam: () => void;
}

/** 본문 도구 모음의 "더보기" 메뉴. 방향키·Home/End·Esc로 쓸 수 있고 바깥을 누르면 닫힌다. */
export function MoreMenu(props: MoreMenuProps) {
  const { disabled, unread, starred, moveTargets, spam } = props;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "move">("main");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setView("main");
    if (restoreFocus) trigger.current?.focus();
  };

  // 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 메뉴가 열리거나 화면(주 메뉴 ↔ 폴더 목록)이 바뀌면 첫 항목에 포커스를 둔다.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, view]);

  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const onKeyDown = (e: KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return focusAt(at + 1);
      case "ArrowUp":
        return focusAt(at < 0 ? -1 : at - 1);
      case "Home":
        return focusAt(0);
      case "End":
        return focusAt(-1);
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        return close(true);
      case "ArrowLeft":
        if (view === "move") {
          e.preventDefault();
          setView("main");
        }
        return;
      case "Tab":
        return close(false);
    }
  };

  // 항목을 고르면 메뉴를 닫고 동작을 실행한다.
  const choose = (action: () => void) => () => {
    close(true);
    action();
  };

  return (
    <div className={styles.root} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`ib ${styles.trigger}`}
        aria-label="더보기"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={20} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div
          id={menuId}
          ref={menu}
          role="menu"
          aria-label={view === "move" ? "폴더로 이동" : "더보기"}
          className={styles.menu}
          onKeyDown={onKeyDown}
        >
          {view === "main" ? (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={styles.item}
                onClick={choose(() => props.onSetRead(unread))}
              >
                {unread ? "읽음으로 표시" : "읽지 않음으로 표시"}
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={styles.item}
                onClick={choose(() => props.onSetStarred(!starred))}
              >
                {starred ? "별표 해제" : "별표 추가"}
              </button>
              {moveTargets.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  tabIndex={-1}
                  className={styles.item}
                  onClick={() => setView("move")}
                >
                  폴더로 이동…
                  <ChevronRight size={16} strokeWidth={1.75} aria-hidden className={styles.chev} />
                </button>
              )}
              {spam && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={styles.item}
                  onClick={choose(props.onToggleSpam)}
                >
                  {spam.isSpam ? "스팸 아님" : "스팸으로 신고"}
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={styles.item}
                onClick={() => setView("main")}
              >
                <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
                뒤로
              </button>
              <div className={styles.sep} role="separator" />
              <div className={styles.scroll}>
                {moveTargets.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={styles.item}
                    style={{ paddingLeft: `calc(var(--space-3) * ${1 + (f.depth ?? 0)})` }}
                    onClick={choose(() => props.onMove(f))}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
