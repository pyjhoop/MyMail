import type { Folder } from "./ipc";

/**
 * 라벨 이름으로 정하는 색 번호(1~8). 같은 이름이면 어느 화면에서나 같은 색이다.
 * 백엔드 `label_color`(src-tauri/src/providers/imap/mod.rs)와 같은 계산이라 메일 행의 칩 색과 맞는다.
 */
export function labelColor(name: string): number {
  let hash = 0;
  for (const byte of new TextEncoder().encode(name)) {
    hash = (Math.imul(hash, 31) + byte) >>> 0;
  }
  return (hash % 8) + 1;
}

/** `tokens.css`의 계정 팔레트 변수로 칠할 때 쓰는 값 */
export function labelColorVar(name: string): string {
  return `var(--account-${labelColor(name)})`;
}

/**
 * 라벨 폴더 목록(서버 순서, 부모가 자식보다 앞)에서 폴더 id별 전체 이름("부모/자식")을 만든다.
 * 폴더 이름은 마지막 조각뿐이라 깊이로 되짚는다. 메일 쪽 라벨 이름과 같은 형태다.
 */
export function labelPaths(labels: Folder[]): Map<string, string> {
  const result = new Map<string, string>();
  const stack: string[] = [];
  for (const f of labels) {
    const depth = f.depth ?? 0;
    stack.length = Math.min(depth, stack.length);
    stack[depth] = f.name;
    result.set(f.id, stack.slice(0, depth + 1).join("/"));
  }
  return result;
}
