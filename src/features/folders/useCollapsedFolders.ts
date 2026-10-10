import { useCallback, useState } from "react";

const key = (accountId: string) => `mymail.collapsedFolders.${accountId}`;

function load(accountId: string): Set<string> {
  try {
    const raw = localStorage.getItem(key(accountId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/** 접힌 부모 폴더·라벨의 id 집합. 계정별로 localStorage에 저장해 다시 켜도 유지한다. */
export function useCollapsedFolders(accountId: string) {
  const [state, setState] = useState(() => ({ accountId, ids: load(accountId) }));
  // 계정이 바뀌면 그 계정의 저장값으로 바꾼다 (렌더 중 상태 보정).
  let current = state;
  if (state.accountId !== accountId) {
    current = { accountId, ids: load(accountId) };
    setState(current);
  }

  const toggle = useCallback(
    (id: string, collapse?: boolean) => {
      setState((prev) => {
        const next = new Set(prev.ids);
        const want = collapse ?? !next.has(id);
        if (want) next.add(id);
        else next.delete(id);
        try {
          localStorage.setItem(key(accountId), JSON.stringify([...next]));
        } catch {
          // 저장 실패는 무시한다 (이번 실행에서만 유지)
        }
        return { accountId, ids: next };
      });
    },
    [accountId],
  );

  return { collapsedIds: current.ids, toggle };
}
