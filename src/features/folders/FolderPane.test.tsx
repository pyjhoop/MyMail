import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder } from "../../lib/ipc";
import { labelColorVar } from "../../lib/labels";
import { FAKE_ACCOUNTS } from "../../test/fixtures";
import { FolderPane } from "./FolderPane";

const folder = (id: string, name: string, extra: Partial<Folder> = {}): Folder => ({
  id,
  accountId: "a1",
  name,
  kind: "label",
  unread: 0,
  ...extra,
});

describe("FolderPane 라벨 색", () => {
  it("라벨 점은 이름으로 정한 색을 쓰고, 하위 라벨은 전체 이름 기준이다", () => {
    const folders = [
      folder("a1-inbox", "받은편지함", { kind: "inbox" }),
      folder("l1", "Work", { colorIndex: 1 }),
      folder("l2", "Sub", { depth: 1 }),
    ];
    render(
      <FolderPane
        account={FAKE_ACCOUNTS[0]}
        accounts={FAKE_ACCOUNTS}
        folders={folders}
        selectedId="a1-inbox"
        collapsed={false}
        onSelect={vi.fn()}
        onCompose={vi.fn()}
      />,
    );
    const dotOf = (name: string) =>
      screen.getByText(name).closest("button")!.querySelector("span > span") as HTMLElement;
    expect(dotOf("Work").style.background).toBe(labelColorVar("Work"));
    expect(dotOf("Sub").style.background).toBe(labelColorVar("Work/Sub"));
  });
});

describe("FolderPane 하위 라벨 접기/펼치기", () => {
  const tree = [
    folder("a1-inbox", "받은편지함", { kind: "inbox" }),
    folder("l1", "Work", { unread: 1 }),
    folder("l2", "Sub", { depth: 1, unread: 2 }),
    folder("l3", "Deep", { depth: 2, unread: 3 }),
    folder("l4", "Solo", { unread: 0 }),
  ];
  const renderPane = (selectedId = "a1-inbox") =>
    render(
      <FolderPane
        account={FAKE_ACCOUNTS[0]}
        accounts={FAKE_ACCOUNTS}
        folders={tree}
        selectedId={selectedId}
        collapsed={false}
        onSelect={vi.fn()}
        onCompose={vi.fn()}
      />,
    );

  beforeEach(() => localStorage.clear());

  it("자식이 없는 라벨에는 토글이 없고 부모에만 있다", () => {
    renderPane();
    expect(screen.getByRole("button", { name: "Work 접기" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Sub 접기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Solo (접기|펼치기)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Deep (접기|펼치기)/ })).not.toBeInTheDocument();
  });

  it("토글로 자식이 숨고 다시 보이며 접힌 부모는 자식 안 읽은 수 합계를 보인다", () => {
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Work 접기" }));
    expect(screen.queryByText("Sub")).not.toBeInTheDocument();
    expect(screen.queryByText("Deep")).not.toBeInTheDocument();
    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Work 펼치기" }));
    expect(screen.getByText("Sub")).toBeInTheDocument();
    expect(screen.getByText("Deep")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("접힘 상태를 저장하고 다시 그릴 때 복원한다", () => {
    const first = renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Work 접기" }));
    first.unmount();
    renderPane();
    expect(screen.queryByText("Sub")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Work 펼치기" })).toBeInTheDocument();
  });

  it("자식이 선택돼 있으면 접힌 부모도 펼쳐 보인다", () => {
    localStorage.setItem("mymail.collapsedFolders.a1", JSON.stringify(["l1", "l2"]));
    renderPane("l3");
    expect(screen.getByText("Sub")).toBeInTheDocument();
    expect(screen.getByText("Deep")).toBeInTheDocument();
  });

  it("방향키 왼쪽·오른쪽으로 접고 편다", () => {
    renderPane();
    const work = screen.getByText("Work").closest("button")!;
    fireEvent.keyDown(work, { key: "ArrowLeft" });
    expect(screen.queryByText("Sub")).not.toBeInTheDocument();
    fireEvent.keyDown(work, { key: "ArrowRight" });
    expect(screen.getByText("Sub")).toBeInTheDocument();
  });
});
