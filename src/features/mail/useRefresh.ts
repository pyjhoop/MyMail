import { useCallback, useEffect, useRef, useState } from "react";
import { syncNow, toLoadError } from "../../lib/ipc";

interface Options {
  /** null이면 모든 계정 */
  accountId: string | null;
  /** 지금 보는 폴더. 가장 먼저 맞춘다. */
  folderId?: string;
  /** 동기화가 끝난(실패 포함) 뒤 목록·안 읽은 수를 다시 읽는다. */
  onDone: () => void;
}

export function syncErrorMessage(e: unknown): string {
  const { kind } = toLoadError(e);
  if (kind === "network") return "인터넷에 연결되어 있지 않아 메일을 가져오지 못했어요.";
  if (kind === "auth") return "계정 인증에 실패했어요. 설정에서 앱 비밀번호를 확인해 주세요.";
  return "메일을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.";
}

/**
 * 새로고침 = 서버와 바로 동기화. 진행 중에는 다시 시작하지 않는다(연타 방지).
 * 실패 안내는 그 계정·폴더를 보는 동안만 보여준다.
 */
export function useRefresh({ accountId, folderId, onDone }: Options) {
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const busy = useRef(false);
  const latest = useRef({ accountId, folderId, onDone });
  useEffect(() => {
    latest.current = { accountId, folderId, onDone };
  });

  const scope = `${accountId ?? "all"}|${folderId ?? ""}`;

  const refresh = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    setFailure(null);
    const { accountId: account, folderId: folder } = latest.current;
    const at = `${account ?? "all"}|${folder ?? ""}`;
    syncNow(account, folder)
      .then(() => setLastSyncedAt(new Date()))
      .catch((e: unknown) => setFailure({ scope: at, message: syncErrorMessage(e) }))
      .finally(() => {
        busy.current = false;
        setRefreshing(false);
        latest.current.onDone();
      });
  }, []);

  return {
    refreshing,
    error: failure?.scope === scope ? failure.message : undefined,
    lastSyncedAt,
    refresh,
  };
}
