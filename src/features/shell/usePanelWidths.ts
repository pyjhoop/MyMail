import { useCallback, useState } from "react";

// 범위는 tokens.css(--folder-width-*, --list-width-*)와 같은 값. 스타일이 아니라 드래그 계산용이다.
export const FOLDER = { min: 180, max: 320, def: 220, collapsed: 56 } as const;
export const LIST = { min: 300, max: 520, def: 360 } as const;
export const RAIL = 64;
export const READER_MIN = 480;

const STORAGE_KEY = "mymail.panelWidths";

export interface PanelWidths {
  folder: number;
  list: number;
  /** 180px 미만으로 끌어 아이콘만 남긴 상태 */
  folderCollapsed: boolean;
}

const DEFAULTS: PanelWidths = { folder: FOLDER.def, list: LIST.def, folderCollapsed: false };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function load(): PanelWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<PanelWidths>;
    return {
      folder: clamp(Number(p.folder) || FOLDER.def, FOLDER.min, FOLDER.max),
      list: clamp(Number(p.list) || LIST.def, LIST.min, LIST.max),
      folderCollapsed: p.folderCollapsed === true,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(w: PanelWidths) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
  } catch {
    // 저장 실패는 무시한다 (다음 실행에서 기본값)
  }
}

export function usePanelWidths() {
  const [widths, setWidths] = useState<PanelWidths>(load);

  const commit = useCallback((next: PanelWidths) => {
    setWidths(next);
    save(next);
  }, []);

  /** 드래그 중 폴더 패널 너비. 최소보다 작으면 접는다. */
  const dragFolder = useCallback(
    (raw: number, windowWidth: number) => {
      if (raw < FOLDER.min) {
        setWidths((w) => ({ ...w, folderCollapsed: true }));
        return;
      }
      const room = windowWidth - RAIL - READER_MIN - widths.list;
      const folder = clamp(raw, FOLDER.min, Math.max(FOLDER.min, Math.min(FOLDER.max, room)));
      setWidths((w) => ({ ...w, folder, folderCollapsed: false }));
    },
    [widths.list],
  );

  const dragList = useCallback(
    (raw: number, windowWidth: number) => {
      const used = RAIL + (widths.folderCollapsed ? FOLDER.collapsed : widths.folder);
      const room = windowWidth - used - READER_MIN;
      const list = clamp(raw, LIST.min, Math.max(LIST.min, Math.min(LIST.max, room)));
      setWidths((w) => ({ ...w, list }));
    },
    [widths.folder, widths.folderCollapsed],
  );

  const endDrag = useCallback(() => {
    setWidths((w) => {
      save(w);
      return w;
    });
  }, []);

  const resetFolder = useCallback(
    () => commit({ ...widths, folder: FOLDER.def, folderCollapsed: false }),
    [commit, widths],
  );
  const resetList = useCallback(() => commit({ ...widths, list: LIST.def }), [commit, widths]);

  return { widths, dragFolder, dragList, endDrag, resetFolder, resetList };
}
