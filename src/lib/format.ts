// 백엔드가 주는 값(유닉스 초, 바이트)을 화면 문구로 바꾼다.

const pad = (n: number) => String(n).padStart(2, "0");

function clock(d: Date): string {
  const h = d.getHours();
  return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${pad(d.getMinutes())}`;
}

function dayDiff(d: Date, now: Date): number {
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((startOf(now) - startOf(d)) / 86_400_000);
}

function dateLabel(d: Date, now: Date): string {
  const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}년 ${md}`;
}

/** 목록용: 오늘은 시각, 어제는 "어제", 그 외는 날짜 */
export function formatListTime(epochSec: number, now: Date = new Date()): string {
  const d = new Date(epochSec * 1000);
  const diff = dayDiff(d, now);
  if (diff === 0) return clock(d);
  if (diff === 1) return "어제";
  return dateLabel(d, now);
}

/** 본문 머리용: 날짜와 시각을 모두 보여준다 */
export function formatFullTime(epochSec: number, now: Date = new Date()): string {
  const d = new Date(epochSec * 1000);
  const diff = dayDiff(d, now);
  const day = diff === 0 ? "오늘" : diff === 1 ? "어제" : dateLabel(d, now);
  return `${day} ${clock(d)}`;
}

/** 답장 인용 머리말용: 항상 연도까지 쓴 날짜와 시각. 예) 2026년 10월 9일 오후 3:20 */
export function formatQuoteTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${clock(d)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
