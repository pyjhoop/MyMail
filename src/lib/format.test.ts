import { describe, expect, it } from "vitest";
import { formatFullTime, formatListTime, formatSize } from "./format";

const now = new Date(2026, 9, 9, 15, 0); // 2026-10-09 오후 3:00
const at = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min).getTime() / 1000;

describe("formatListTime", () => {
  it("오늘은 시각, 어제는 '어제', 그 외는 날짜", () => {
    expect(formatListTime(at(2026, 10, 9, 9, 12), now)).toBe("오전 9:12");
    expect(formatListTime(at(2026, 10, 9, 0, 5), now)).toBe("오전 12:05");
    expect(formatListTime(at(2026, 10, 9, 13, 30), now)).toBe("오후 1:30");
    expect(formatListTime(at(2026, 10, 8, 23, 59), now)).toBe("어제");
    expect(formatListTime(at(2026, 10, 6, 9, 0), now)).toBe("10월 6일");
    expect(formatListTime(at(2025, 12, 31, 9, 0), now)).toBe("2025년 12월 31일");
  });
});

describe("formatFullTime", () => {
  it("날짜 문구 뒤에 시각을 붙인다", () => {
    expect(formatFullTime(at(2026, 10, 9, 9, 12), now)).toBe("오늘 오전 9:12");
    expect(formatFullTime(at(2026, 10, 7, 14, 3), now)).toBe("10월 7일 오후 2:03");
  });
});

describe("formatSize", () => {
  it("B·KB·MB로 줄인다", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(384_000)).toBe("384 KB");
    expect(formatSize(1_250_000)).toBe("1.3 MB");
  });
});
