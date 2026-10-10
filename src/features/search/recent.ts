// 최근 검색. 이 기기에만 저장한다(localStorage). 저장할 수 없는 환경에서도 앱은 그대로 동작한다.

const KEY = "mymail.recentSearches";
export const MAX_RECENT = 8;

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "")
      : [];
  } catch {
    return [];
  }
}

function write(list: string[]): string[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 저장하지 못해도 이번 실행 동안은 화면 상태로 쓴다.
  }
  return list;
}

export function loadRecent(): string[] {
  return read().slice(0, MAX_RECENT);
}

/** 맨 앞에 넣고 같은 검색은 합친다. 개수는 MAX_RECENT까지. */
export function addRecent(query: string): string[] {
  const q = query.trim();
  if (!q) return loadRecent();
  return write([q, ...read().filter((r) => r !== q)].slice(0, MAX_RECENT));
}

export function removeRecent(query: string): string[] {
  return write(read().filter((r) => r !== query));
}
