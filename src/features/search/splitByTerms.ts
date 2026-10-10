/** 대소문자를 가리지 않고 검색어가 나온 곳을 기준으로 나눈다. 겹치는 구간은 합친다. */
export function splitByTerms(
  text: string,
  terms: readonly string[],
): { text: string; hit: boolean }[] {
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (needles.length === 0 || text === "") return [{ text, hit: false }];
  const lower = text.toLowerCase();
  // toLowerCase가 길이를 바꾸는 드문 글자가 있으면 위치가 어긋나므로 강조하지 않는다.
  if (lower.length !== text.length) return [{ text, hit: false }];
  const ranges: [number, number][] = [];
  for (const n of needles) {
    for (let at = lower.indexOf(n); at >= 0; at = lower.indexOf(n, at + n.length)) {
      ranges.push([at, at + n.length]);
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) out.push({ text: text.slice(pos, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}
