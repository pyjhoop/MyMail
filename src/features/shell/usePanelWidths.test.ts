import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FOLDER, LIST, usePanelWidths } from "./usePanelWidths";

describe("usePanelWidths", () => {
  beforeEach(() => localStorage.clear());

  it("기본값으로 시작한다", () => {
    const { result } = renderHook(() => usePanelWidths());
    expect(result.current.widths).toEqual({
      folder: FOLDER.def,
      list: LIST.def,
      folderCollapsed: false,
    });
  });

  it("목록 너비를 300~520px 범위로 제한한다", () => {
    const { result } = renderHook(() => usePanelWidths());
    act(() => result.current.dragList(100, 1600));
    expect(result.current.widths.list).toBe(LIST.min);
    act(() => result.current.dragList(900, 1600));
    expect(result.current.widths.list).toBe(LIST.max);
  });

  it("본문 최소 너비(480px)를 지키도록 목록을 줄인다", () => {
    const { result } = renderHook(() => usePanelWidths());
    // 창 1100: 1100 - 레일 64 - 폴더 220 - 본문 480 = 336
    act(() => result.current.dragList(500, 1100));
    expect(result.current.widths.list).toBe(336);
  });

  it("폴더를 180px 미만으로 끌면 접힌다", () => {
    const { result } = renderHook(() => usePanelWidths());
    act(() => result.current.dragFolder(120, 1600));
    expect(result.current.widths.folderCollapsed).toBe(true);
    act(() => result.current.dragFolder(250, 1600));
    expect(result.current.widths).toMatchObject({ folder: 250, folderCollapsed: false });
  });

  it("드래그가 끝나면 저장하고 다음 실행에서 복원한다", () => {
    const first = renderHook(() => usePanelWidths());
    act(() => first.result.current.dragList(450, 1600));
    act(() => first.result.current.endDrag());
    first.unmount();
    const second = renderHook(() => usePanelWidths());
    expect(second.result.current.widths.list).toBe(450);
  });

  it("더블클릭 리셋은 기본값으로 되돌린다", () => {
    const { result } = renderHook(() => usePanelWidths());
    act(() => result.current.dragList(450, 1600));
    act(() => result.current.resetList());
    expect(result.current.widths.list).toBe(LIST.def);
  });
});
