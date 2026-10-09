import { useEffect, useRef } from "react";

/** 단축키 목록. 설정의 "단축키" 탭과 본문 힌트가 같은 목록을 쓴다. */
export const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "c", label: "새 메일" },
  { keys: "r", label: "답장" },
  { keys: "a", label: "전체 답장" },
  { keys: "f", label: "전달" },
  { keys: "#", label: "삭제" },
  { keys: "/", label: "검색" },
  { keys: "j", label: "다음 메일" },
  { keys: "k", label: "이전 메일" },
  { keys: "F5 / Ctrl + R", label: "새로고침 (서버와 바로 동기화)" },
  { keys: "Ctrl + 1~9", label: "계정 전환 (1은 통합 받은편지함)" },
  { keys: "Ctrl + Enter", label: "메일 보내기" },
  { keys: "Esc", label: "설정·검색 닫기" },
];

export interface ShortcutHandlers {
  compose: () => void;
  reply: () => void;
  replyAll: () => void;
  forward: () => void;
  remove: () => void;
  search: () => void;
  next: () => void;
  prev: () => void;
  /** F5·Ctrl+R. 웹뷰 새로고침 대신 앱의 동기화로 연결한다 */
  refresh: () => void;
  /** 1부터 시작. 1은 통합 받은편지함, 2부터는 계정 순서대로 */
  switchAccount: (n: number) => void;
}

/** 글자를 입력하는 곳에서는 한 글자 단축키가 입력을 가로채지 않게 한다. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/** Gmail 방식 단축키. `enabled`가 false면(설정·대화상자가 떠 있을 때 등) 아무것도 하지 않는다. */
export function useShortcuts(handlers: ShortcutHandlers, enabled: boolean) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const h = ref.current;

      if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        h.switchAccount(Number(e.key));
        return;
      }
      // 웹뷰가 페이지를 통째로 다시 불러오지 않게 막고, 입력 중이어도 동기화로 연결한다.
      if (
        !e.altKey &&
        !e.shiftKey &&
        ((e.key === "F5" && !e.ctrlKey && !e.metaKey) ||
          ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r"))
      ) {
        e.preventDefault();
        h.refresh();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;

      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      switch (e.key) {
        case "c":
          return run(h.compose);
        case "r":
          return run(h.reply);
        case "a":
          return run(h.replyAll);
        case "f":
          return run(h.forward);
        case "#":
          return run(h.remove);
        case "/":
          return run(h.search);
        case "j":
          return run(h.next);
        case "k":
          return run(h.prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
