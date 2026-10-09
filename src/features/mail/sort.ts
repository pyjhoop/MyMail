import { useCallback, useState } from "react";
import type { MailSort } from "../../lib/ipc";

export const SORT_OPTIONS: { id: MailSort; label: string }[] = [
  { id: "newest", label: "최신순" },
  { id: "oldest", label: "오래된순" },
  { id: "sender", label: "보낸사람순" },
  { id: "subject", label: "제목순" },
  { id: "unread", label: "안 읽음 먼저" },
];

const KEY = "mymail.mailSort";

export function sortLabel(sort: MailSort): string {
  return SORT_OPTIONS.find((o) => o.id === sort)?.label ?? "최신순";
}

/** 저장된 정렬을 읽는다. 없거나 알 수 없는 값이면 최신순. */
export function loadSort(): MailSort {
  try {
    const saved = localStorage.getItem(KEY);
    return SORT_OPTIONS.find((o) => o.id === saved)?.id ?? "newest";
  } catch {
    return "newest";
  }
}

function saveSort(sort: MailSort) {
  try {
    localStorage.setItem(KEY, sort);
  } catch {
    // 저장하지 못해도 이번 실행에서는 그대로 쓴다.
  }
}

/** 정렬 선택. 폴더·계정과 상관없이 하나를 공통으로 쓰고 다음 실행 때 복원한다. */
export function useMailSort(): [MailSort, (next: MailSort) => void] {
  const [sort, setSort] = useState<MailSort>(loadSort);
  const change = useCallback((next: MailSort) => {
    setSort(next);
    saveSort(next);
  }, []);
  return [sort, change];
}
