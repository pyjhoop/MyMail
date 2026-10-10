import type { SyncProgress } from "./ipc";

export type SyncTone = "ok" | "busy" | "error" | "idle";

export interface SyncStatus {
  text: string;
  tone: SyncTone;
}

/** 마지막으로 동기화가 끝난 시각을 "방금"·"N분 전"·"N시간 전"으로 */
export function formatSyncedAgo(syncedAt: number, now: number): string {
  const minutes = Math.floor((now - syncedAt) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** 계정 카드 머리줄에 보여 줄 동기화 상태. `progress`는 마지막으로 받은 진행 알림, `syncedAt`은 마지막 성공 시각(ms). */
export function syncStatus(
  progress: SyncProgress | undefined,
  syncedAt: number | undefined,
  now: number,
): SyncStatus {
  const ago = syncedAt === undefined ? undefined : formatSyncedAgo(syncedAt, now);
  if (progress?.error != null) {
    switch (progress.errorKind) {
      case "auth":
        return { text: "인증 오류 · 비밀번호를 확인해 주세요", tone: "error" };
      case "network":
        return { text: ago ? `오프라인 · 마지막 동기화 ${ago}` : "오프라인", tone: "error" };
      default:
        return { text: "동기화 오류", tone: "error" };
    }
  }
  if (progress && progress.done < progress.total) {
    const percent = Math.min(99, Math.floor((progress.done / progress.total) * 100));
    return { text: `동기화 중 ${percent}%`, tone: "busy" };
  }
  if (ago) return { text: `동기화됨 · ${ago}`, tone: "ok" };
  return { text: "동기화 대기 중", tone: "idle" };
}
