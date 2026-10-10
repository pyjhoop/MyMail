// 결과 목록 위 필터 칩이 검색창 입력(`from:` `has:첨부` `after:`)을 넣고 빼는 도구.
// 필터의 진짜 값은 검색창 문자열 하나다 — 칩은 그것을 고치는 단축 버튼이다.

import { applyOperator, parseSearchQuery, tokenize, type SearchQuery } from "./query";

/** 원문 그대로(따옴표 포함) 따옴표 밖의 공백으로 나눈다. */
export function splitRaw(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const c of input) {
    if (c === '"') inQuote = !inQuote;
    if (/\s/.test(c) && !inQuote) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export type OperatorKey = "from" | "to" | "has" | "is" | "after" | "before";

/** 토큰이 올바른 연산자면 이름과 값. 모르는 연산자·잘못된 값·구절 검색어면 null. */
export function operatorOf(raw: string): { key: OperatorKey; value: string } | null {
  const first = tokenize(raw)[0];
  if (!first || (first.quoted && !first.text.includes(":"))) return null;
  const probe: SearchQuery = { terms: [], from: [], to: [], hasAttachment: false, starred: false };
  if (!applyOperator(probe, first.text)) return null;
  const at = first.text.indexOf(":");
  return {
    key: first.text.slice(0, at).toLowerCase() as OperatorKey,
    value: first.text.slice(at + 1).trim(),
  };
}

/** 조건에 맞는 연산자 토큰을 뺀 입력 */
export function removeOperators(
  input: string,
  match: (op: { key: OperatorKey; value: string }) => boolean,
): string {
  return splitRaw(input)
    .filter((t) => {
      const op = operatorOf(t);
      return !(op && match(op));
    })
    .join(" ");
}

/** 입력 끝에 토큰을 붙인다. 이미 있으면 그대로. */
export function appendToken(input: string, token: string): string {
  const tokens = splitRaw(input);
  return tokens.includes(token) ? tokens.join(" ") : [...tokens, token].join(" ");
}

const isAttachment = (op: { key: OperatorKey; value: string }) =>
  op.key === "has" && ["첨부", "attachment", "attach"].includes(op.value.toLowerCase());

export function toggleAttachment(input: string, on: boolean): string {
  return on ? appendToken(input, "has:첨부") : removeOperators(input, isAttachment);
}

export function removeSender(input: string, value: string): string {
  return removeOperators(input, (op) => op.key === "from" && op.value === value);
}

export function removePeriod(input: string): string {
  return removeOperators(input, (op) => op.key === "after" || op.key === "before");
}

/** 기간을 `after:날짜` 하나로 바꾼다(앞서 있던 기간 조건은 지운다). */
export function setPeriod(input: string, afterDate: string): string {
  return appendToken(removePeriod(input), `after:${afterDate}`);
}

export interface ActiveFilters {
  from: string[];
  hasAttachment: boolean;
  after?: string;
  before?: string;
}

export function activeFilters(input: string): ActiveFilters {
  const q = parseSearchQuery(input);
  return { from: q.from, hasAttachment: q.hasAttachment, after: q.after, before: q.before };
}

/** 로컬 날짜 `YYYY-MM-DD` (표준 시간대를 따른다) */
export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface Period {
  id: string;
  label: string;
  start: (now: Date) => Date;
}

function monthsAgo(now: Date, n: number): Date {
  const d = new Date(now);
  d.setMonth(d.getMonth() - n);
  return d;
}

export const PERIODS: Period[] = [
  {
    id: "week",
    label: "최근 1주일",
    start: (now) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7),
  },
  { id: "month", label: "최근 1개월", start: (now) => monthsAgo(now, 1) },
  { id: "quarter", label: "최근 3개월", start: (now) => monthsAgo(now, 3) },
  { id: "year", label: "최근 1년", start: (now) => monthsAgo(now, 12) },
];

/** `after` 날짜가 오늘 기준 어느 기간 선택과 같으면 그 이름("최근 3개월") */
export function periodLabelFor(after: string, now: Date = new Date()): string | undefined {
  return PERIODS.find((p) => formatDate(p.start(now)) === after)?.label;
}

/** 칩에 보일 기간 설명. `before:`만 있거나 직접 쓴 날짜면 날짜로 보인다. */
export function periodChipText(f: ActiveFilters, now: Date = new Date()): string | undefined {
  if (!f.after && !f.before) return undefined;
  if (f.after && !f.before) return periodLabelFor(f.after, now) ?? `${f.after} 이후`;
  if (!f.after && f.before) return `${f.before} 이전`;
  return `${f.after} ~ ${f.before}`;
}

/** "3개월보다 오래된 결과" 안내에 쓰는 말. 기간 선택과 같으면 "3개월", 아니면 "2026-07-10 이전". */
export function olderThanText(after: string, now: Date = new Date()): string {
  const label = periodLabelFor(after, now);
  return label ? `${label.replace("최근 ", "")}보다 오래된` : `${after} 이전의`;
}
