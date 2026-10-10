import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addLabel,
  createLabel,
  deleteLabel,
  removeLabel,
  renameLabel,
  supportsLabels,
  type Folder,
} from "../../lib/ipc";
import { FAKE_ACCOUNTS } from "../../test/fixtures";
import { FolderPane } from "../folders/FolderPane";
import { LabelButton } from "./LabelButton";
import { LabelChips } from "./LabelChips";
import { LabelManage } from "./LabelManage";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    supportsLabels: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    createLabel: vi.fn(),
    renameLabel: vi.fn(),
    deleteLabel: vi.fn(),
    listFolders: vi.fn(() => Promise.resolve([])),
  };
});

const label = (id: string, name: string, extra: Partial<Folder> = {}): Folder => ({
  id,
  accountId: "a1",
  name,
  kind: "label",
  unread: 0,
  ...extra,
});
const FOLDERS = [
  label("l1", "가족"),
  label("l2", "여행"),
  label("l3", "제주", { path: "여행/제주" }),
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(supportsLabels).mockResolvedValue(true);
  vi.mocked(addLabel).mockResolvedValue();
  vi.mocked(removeLabel).mockResolvedValue();
  vi.mocked(deleteLabel).mockResolvedValue();
  vi.mocked(renameLabel).mockResolvedValue();
});

function setup(mails: { id: string; labels: string[] }[]) {
  const onChanged = vi.fn();
  const onError = vi.fn();
  render(
    <LabelButton
      accountId="a1"
      mails={mails}
      folders={FOLDERS}
      open
      onOpenChange={vi.fn()}
      onChanged={onChanged}
      onError={onError}
    />,
  );
  return { onChanged, onError };
}

describe("LabelButton", () => {
  it("라벨을 지원하지 않으면 아무것도 그리지 않는다", async () => {
    vi.mocked(supportsLabels).mockResolvedValue(false);
    setup([{ id: "m1", labels: [] }]);
    await waitFor(() => expect(supportsLabels).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "라벨" })).not.toBeInTheDocument();
  });

  it("체크하면 addLabel, 체크 해제하면 removeLabel을 부른다", async () => {
    const { onChanged } = setup([{ id: "m1", labels: ["가족"] }]);
    const family = await screen.findByRole("checkbox", { name: /가족/ });
    expect(family).toBeChecked();
    fireEvent.click(family);
    await waitFor(() => expect(removeLabel).toHaveBeenCalledWith(["m1"], "가족"));
    expect(onChanged).toHaveBeenCalledWith({ ids: ["m1"], label: "가족", added: false });

    fireEvent.click(screen.getByRole("checkbox", { name: /^여행$/ }));
    await waitFor(() => expect(addLabel).toHaveBeenCalledWith(["m1"], "여행"));
  });

  it("여러 메일에서 일부만 붙은 라벨은 중간 상태이고, 누르면 나머지에 붙인다", async () => {
    setup([
      { id: "m1", labels: ["가족"] },
      { id: "m2", labels: [] },
    ]);
    const family = await screen.findByRole("checkbox", { name: /가족/ });
    expect((family as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(family);
    await waitFor(() => expect(addLabel).toHaveBeenCalledWith(["m2"], "가족"));
  });

  it("검색으로 거르고 하위 라벨은 전체 이름으로 보인다", async () => {
    setup([{ id: "m1", labels: [] }]);
    fireEvent.change(await screen.findByRole("searchbox", { name: "라벨 검색" }), {
      target: { value: "제주" },
    });
    expect(screen.getByText("여행/제주")).toBeInTheDocument();
    expect(screen.queryByText("가족")).not.toBeInTheDocument();
  });

  it("새 라벨을 만들면 바로 붙인다", async () => {
    vi.mocked(createLabel).mockResolvedValue(label("l9", "새", { path: "일/새" }));
    const { onChanged } = setup([{ id: "m1", labels: [] }]);
    fireEvent.change(await screen.findByRole("searchbox", { name: "라벨 검색" }), {
      target: { value: "일/새" },
    });
    fireEvent.click(screen.getByRole("button", { name: /새 라벨 만들기/ }));
    await waitFor(() => expect(createLabel).toHaveBeenCalledWith("a1", "일/새"));
    await waitFor(() => expect(addLabel).toHaveBeenCalledWith(["m1"], "일/새"));
    expect(onChanged).toHaveBeenCalledWith({ ids: ["m1"], label: "일/새", added: true });
  });

  it("실패하면 한국어 안내를 알린다", async () => {
    vi.mocked(addLabel).mockRejectedValue({ kind: "unknown", message: "오프라인" });
    const { onError } = setup([{ id: "m1", labels: [] }]);
    fireEvent.click(await screen.findByRole("checkbox", { name: /가족/ }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("라벨을 바꾸지 못했어요. 오프라인"));
  });
});

describe("LabelChips", () => {
  it("×를 누르면 그 라벨을 뗀다", () => {
    const onRemove = vi.fn();
    render(<LabelChips labels={[{ name: "가족" }]} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "가족 라벨 떼기" }));
    expect(onRemove).toHaveBeenCalledWith("가족");
  });
});

describe("LabelManage", () => {
  it("이름 바꾸기는 renameLabel을 부르고 끝나면 알린다", async () => {
    const onDone = vi.fn();
    render(
      <LabelManage
        accountId="a1"
        target={{ kind: "rename", folder: FOLDERS[0], path: "가족" }}
        onClose={vi.fn()}
        onDone={onDone}
        onError={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "라벨 이름" }), {
      target: { value: "친척" },
    });
    fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
    await waitFor(() => expect(renameLabel).toHaveBeenCalledWith("a1", "l1", "친척"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("서버가 이름을 거절하면 창 안에 안내가 보인다", async () => {
    vi.mocked(createLabel).mockRejectedValue({
      kind: "unknown",
      message: "이미 있는 라벨 이름이에요.",
    });
    render(
      <LabelManage
        accountId="a1"
        target={{ kind: "create" }}
        onClose={vi.fn()}
        onDone={vi.fn()}
        onError={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "라벨 이름" }), {
      target: { value: "가족" },
    });
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("이미 있는 라벨 이름이에요.");
  });

  it("삭제 확인 창은 메일이 지워지지 않음을 알리고 확인하면 deleteLabel을 부른다", async () => {
    const onDone = vi.fn();
    render(
      <LabelManage
        accountId="a1"
        target={{ kind: "delete", folder: FOLDERS[0], path: "가족" }}
        onClose={vi.fn()}
        onDone={onDone}
        onError={vi.fn()}
      />,
    );
    expect(screen.getByText(/메일은 지워지지 않고/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(deleteLabel).toHaveBeenCalledWith("a1", "l1"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});

describe("FolderPane 라벨 메뉴", () => {
  it("라벨 행을 우클릭하면 이름 바꾸기·삭제 메뉴가 뜬다", () => {
    render(
      <FolderPane
        account={FAKE_ACCOUNTS[0]}
        accounts={FAKE_ACCOUNTS}
        folders={[{ ...label("a1-inbox", "받은편지함"), kind: "inbox" }, ...FOLDERS]}
        selectedId="a1-inbox"
        collapsed={false}
        onSelect={vi.fn()}
        onCompose={vi.fn()}
        onLabelsChanged={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByText("가족").closest("button")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "이름 바꾸기" }));
    expect(screen.getByRole("dialog", { name: "라벨 이름 바꾸기" })).toBeInTheDocument();
  });
});
