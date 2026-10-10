// 검색창 입력 해석. 백엔드(`store/search.rs`의 ParsedQuery)와 같은 규칙이어야 한다.
// 여기서는 강조할 검색어, 최근 검색의 연산자 표시, 시간대 계산에만 쓰고 실제 검색은 백엔드가 한다.

export interface SearchQuery {
  /** 일반 검색어 */
  terms: string[];
  from: string[];
  to: string[];
  hasAttachment: boolean;
  unread?: boolean;
  starred: boolean;
  /** YYYY-MM-DD */
  after?: string;
  before?: string;
}

/** 따옴표를 지키며 공백으로 나눈다. `from:"한결 카드"`는 `from:한결 카드` 한 토큰이 된다. */
export function tokenize(input: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  let cur = "";
  let inQuote = false;
  let quoted = false;
  for (const c of input) {
    if (c === '"') {
      inQuote = !inQuote;
      quoted = true;
    } else if (/\s/.test(c) && !inQuote) {
      if (cur) out.push({ text: cur, quoted });
      cur = "";
      quoted = false;
    } else {
      cur += c;
    }
  }
  if (cur) out.push({ text: cur, quoted });
  return out;
}

/** 존재하는 날짜인지 확인한다 (백엔드 parse_date와 같은 규칙). */
export function isValidDate(value: string): boolean {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = mo === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(mo) ? 30 : 31;
  return d <= days;
}

/** 토큰이 연산자면 해석해 query에 반영하고 true. 모르는 연산자·잘못된 값이면 false(일반 검색어). */
export function applyOperator(q: SearchQuery, token: string): boolean {
  const at = token.indexOf(":");
  if (at < 0) return false;
  const key = token.slice(0, at).toLowerCase();
  const value = token.slice(at + 1).trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  switch (key) {
    case "from":
      q.from.push(value);
      return true;
    case "to":
      q.to.push(value);
      return true;
    case "has":
      if (lower === "첨부" || lower === "attachment" || lower === "attach") {
        q.hasAttachment = true;
        return true;
      }
      return false;
    case "is":
      if (lower === "안읽음" || lower === "unread") q.unread = true;
      else if (lower === "읽음" || lower === "read") q.unread = false;
      else if (lower === "별표" || lower === "starred") q.starred = true;
      else return false;
      return true;
    case "after":
    case "before":
      if (!isValidDate(value)) return false;
      q[key] = value;
      return true;
    default:
      return false;
  }
}

export function parseSearchQuery(input: string): SearchQuery {
  const q: SearchQuery = { terms: [], from: [], to: [], hasAttachment: false, starred: false };
  for (const { text, quoted } of tokenize(input)) {
    if (quoted && !text.includes(":")) q.terms.push(text);
    else if (!applyOperator(q, text)) q.terms.push(text);
  }
  return q;
}

/** 본문 강조에 쓸 단어들. 글자나 숫자가 없는 조각은 뺀다. */
export function highlightTerms(input: string): string[] {
  return parseSearchQuery(input).terms.filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/** 입력이 연산자를 쓰는지(최근 검색에서 코드 칩으로 따로 보여 줄 때). */
export function splitOperators(input: string): { text: string; operators: string[] } {
  const texts: string[] = [];
  const operators: string[] = [];
  for (const { text, quoted } of tokenize(input)) {
    const probe: SearchQuery = {
      terms: [],
      from: [],
      to: [],
      hasAttachment: false,
      starred: false,
    };
    if (!(quoted && !text.includes(":")) && applyOperator(probe, text)) operators.push(text);
    else texts.push(text);
  }
  return { text: texts.join(" "), operators };
}

/** UTC와의 차이(초). `after:`/`before:`를 사용자의 시간대 0시로 해석하게 백엔드에 알린다. */
export function tzOffsetSecs(now: Date = new Date()): number {
  return -now.getTimezoneOffset() * 60;
}

/** 한 글자만 있는 입력은 자동 검색하지 않는다(결과가 너무 넓다). 연산자가 있으면 검색한다. */
export function isTooShortToSearch(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed === "") return false;
  if (trimmed.length >= 2) return false;
  return true;
}

/** 마지막 단어가 값을 아직 안 쓴 연산자(`from:`)인지. 쓰는 중에는 자동 검색하지 않는다. */
export function hasIncompleteOperator(input: string): boolean {
  const last = input.trimEnd().split(/\s+/).pop() ?? "";
  return /^(from|to|has|is|after|before):$/i.test(last);
}

/** 검색어 팁 칩. 누르면 입력에 덧붙인다. */
export const TIPS = ["from:", "to:", "has:첨부", "is:안읽음", "is:별표", "after:날짜"] as const;
/** 칩에 보이는 글과 실제로 덧붙일 글이 다른 것 */
export const TIP_INSERT: Record<string, string> = { "after:날짜": "after:" };
