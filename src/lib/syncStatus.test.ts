import { describe, expect, it } from "vitest";
import type { SyncProgress } from "./ipc";
import { formatSyncedAgo, syncStatus } from "./syncStatus";

const NOW = 1_760_000_000_000;
const MIN = 60_000;
const p = (patch: Partial<SyncProgress>): SyncProgress => ({
  accountId: "a1",
  done: 0,
  total: 0,
  error: null,
  errorKind: null,
  ...patch,
});

describe("동기화 상태 문구", () => {
  it("방금·N분·N시간·N일 전", () => {
    expect(formatSyncedAgo(NOW - 20_000, NOW)).toBe("방금");
    expect(formatSyncedAgo(NOW - 2 * MIN, NOW)).toBe("2분 전");
    expect(formatSyncedAgo(NOW - 3 * 60 * MIN, NOW)).toBe("3시간 전");
    expect(formatSyncedAgo(NOW - 50 * 60 * MIN, NOW)).toBe("2일 전");
  });

  it("끝난 동기화는 '동기화됨 · 방금'", () => {
    expect(syncStatus(p({ done: 5, total: 5 }), NOW - 1000, NOW)).toEqual({
      text: "동기화됨 · 방금",
      tone: "ok",
    });
  });

  it("진행 중이면 퍼센트를 보인다(100%는 끝날 때까지 99%)", () => {
    expect(syncStatus(p({ done: 64, total: 100 }), undefined, NOW)).toEqual({
      text: "동기화 중 64%",
      tone: "busy",
    });
    expect(syncStatus(p({ done: 99, total: 100 }), NOW, NOW).text).toBe("동기화 중 99%");
  });

  it("아직 알림이 없으면 대기 중", () => {
    expect(syncStatus(undefined, undefined, NOW)).toEqual({ text: "동기화 대기 중", tone: "idle" });
  });

  it("오프라인·인증·기타 오류를 구분한다", () => {
    const net = syncStatus(p({ error: "x", errorKind: "network" }), NOW - 5 * MIN, NOW);
    expect(net).toEqual({ text: "오프라인 · 마지막 동기화 5분 전", tone: "error" });
    expect(syncStatus(p({ error: "x", errorKind: "network" }), undefined, NOW).text).toBe(
      "오프라인",
    );
    expect(syncStatus(p({ error: "x", errorKind: "auth" }), NOW, NOW).text).toContain("인증 오류");
    expect(syncStatus(p({ error: "x", errorKind: "other" }), NOW, NOW).text).toBe("동기화 오류");
    expect(syncStatus(p({ error: "x" }), NOW, NOW).tone).toBe("error");
  });
});
