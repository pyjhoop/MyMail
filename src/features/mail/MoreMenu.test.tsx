import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Folder } from "../../lib/ipc";
import { MoreMenu, type MoreMenuProps } from "./MoreMenu";
import { Toast } from "../../components/Toast";

const target: Folder = {
  id: "a1-proj",
  accountId: "a1",
  name: "프로젝트",
  kind: "folder",
  unread: 0,
};

function setup(over: Partial<MoreMenuProps> = {}) {
  const props: MoreMenuProps = {
    disabled: false,
    unread: false,
    starred: false,
    moveTargets: [target],
    spam: { isSpam: false },
    onSetRead: vi.fn(),
    onSetStarred: vi.fn(),
    onMove: vi.fn(),
    onToggleSpam: vi.fn(),
    ...over,
  };
  render(<MoreMenu {...props} />);
  return props;
}

const trigger = () => screen.getByRole("button", { name: "더보기" });

describe("MoreMenu", () => {
  it("열면 첫 항목에 포커스가 가고 방향키로 오간다", () => {
    setup();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger());

    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "읽지 않음으로 표시",
      "별표 추가",
      "폴더로 이동…",
      "스팸으로 신고",
    ]);
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: "ArrowUp" });
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(items[3]).toHaveFocus();
    fireEvent.keyDown(items[3], { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "End" });
    expect(items[3]).toHaveFocus();
  });

  it("Esc로 닫으면 더보기 버튼으로 포커스가 돌아온다", () => {
    setup();
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("바깥을 누르면 닫는다", () => {
    setup();
    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("항목마다 해당 동작을 부르고 메뉴를 닫는다", () => {
    const props = setup({ unread: true, starred: true, spam: { isSpam: true } });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitem", { name: "읽음으로 표시" }));
    expect(props.onSetRead).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitem", { name: "별표 해제" }));
    expect(props.onSetStarred).toHaveBeenCalledWith(false);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitem", { name: "스팸 아님" }));
    expect(props.onToggleSpam).toHaveBeenCalledTimes(1);
  });

  it("폴더 목록은 방향키 왼쪽이나 뒤로로 주 메뉴에 돌아간다", () => {
    const props = setup();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitem", { name: /폴더로 이동/ }));
    expect(screen.getByRole("menu", { name: "폴더로 이동" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "뒤로" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menuitem", { name: "뒤로" }), { key: "ArrowLeft" });
    expect(screen.getByRole("menu", { name: "더보기" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /폴더로 이동/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "프로젝트" }));
    expect(props.onMove).toHaveBeenCalledWith(target);
  });

  it("옮길 폴더나 스팸함이 없으면 그 항목을 보여 주지 않는다", () => {
    setup({ moveTargets: [], spam: undefined });
    fireEvent.click(trigger());

    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("비활성이면 열리지 않는다", () => {
    setup({ disabled: true });
    expect(trigger()).toBeDisabled();
  });
});

describe("Toast", () => {
  it("메시지와 실행 취소 버튼을 그린다", () => {
    const onAction = vi.fn();
    render(<Toast message="보관했어요" actionLabel="실행 취소" onAction={onAction} />);

    expect(screen.getByRole("status")).toHaveTextContent("보관했어요");
    fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("동작이 없으면 버튼을 그리지 않는다", () => {
    render(<Toast message="옮겼어요" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
