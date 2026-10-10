import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
