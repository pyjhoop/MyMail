import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as ipc from "./lib/ipc";
import { deleteMail, listFolders, listMails, type Folder } from "./lib/ipc";
import { FAKE_FOLDERS, FAKE_MAILS } from "./test/fixtures";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    deleteMail: vi.fn(() => Promise.resolve()),
    setRead: vi.fn(() => Promise.resolve()),
    listFolders: vi.fn(actual.listFolders),
    listMails: vi.fn(actual.listMails),
  };
});

// jsdom은 크기가 0이라 가상화 목록이 행을 그리지 않는다. 모든 행을 그리는 대역으로 바꾼다.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 84,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 84 })),
  }),
}));

const deleteButton = () =>
  within(screen.getByRole("region", { name: "메일 목록" })).getByRole("button", { name: "삭제" });
const checkboxes = () => screen.findAllByRole("checkbox");

describe("메일 삭제", () => {
  beforeEach(() => {
    vi.mocked(deleteMail).mockReset();
    vi.mocked(deleteMail).mockResolvedValue(undefined);
  });

  it("선택한 메일마다 deleteMail을 부르고 선택을 해제한다 (통합 받은편지함)", async () => {
    render(<App />);
    const boxes = await checkboxes();
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2]);
    fireEvent.click(deleteButton());

    await waitFor(() => expect(deleteMail).toHaveBeenCalledTimes(2));
    expect(deleteMail).toHaveBeenCalledWith("a1-inbox-0");
    expect(deleteMail).toHaveBeenCalledWith("a3-inbox-0");
    // 휴지통 밖이므로 확인 창 없이 지운다
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(deleteButton()).toBeDisabled());
  });

  it("일부가 실패하면 실패한 개수를 알린다", async () => {
    vi.mocked(deleteMail).mockRejectedValueOnce(new Error("실패"));
    render(<App />);
    const boxes = await checkboxes();
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(deleteButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("메일 1통을 삭제하지 못했어요");
    expect(deleteMail).toHaveBeenCalledTimes(2);
  });

  it("계정을 바꾸면 선택을 해제한다", async () => {
    render(<App />);
    fireEvent.click((await checkboxes())[0]);
    expect(screen.getByText("선택 1개")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^개인 Gmail/ }));

    await waitFor(() => expect(screen.queryByText("선택 1개")).not.toBeInTheDocument());
  });
});

describe("휴지통에서 삭제", () => {
  const trash: Folder = {
    id: "a1-trash",
    accountId: "a1",
    name: "휴지통",
    kind: "trash",
    unread: 0,
  };

  beforeEach(() => {
    vi.mocked(deleteMail).mockReset();
    vi.mocked(deleteMail).mockResolvedValue(undefined);
    // 계정 a1: 받은편지함 + 휴지통, 휴지통에는 메일 한 통
    vi.mocked(listFolders).mockImplementation(async (accountId) => [
      ...FAKE_FOLDERS.filter((f) => f.accountId === accountId),
      ...(accountId === "a1" ? [trash] : []),
    ]);
    vi.mocked(listMails).mockImplementation(async (_accountId, folderId) =>
      folderId === "a1-trash"
        ? [{ ...FAKE_MAILS[0], id: "a1-trash-0", folderId: "a1-trash", time: "오전 9:00" }]
        : [],
    );
  });

  afterEach(async () => {
    const actual = await vi.importActual<typeof ipc>("./lib/ipc");
    vi.mocked(listFolders).mockImplementation(actual.listFolders);
    vi.mocked(listMails).mockImplementation(actual.listMails);
  });

  it("확인 창을 거치고, 취소하면 지우지 않는다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^개인 Gmail/ }));
    fireEvent.click(await screen.findByText("휴지통"));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(deleteButton());

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("1통");
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(deleteMail).not.toHaveBeenCalled();

    fireEvent.click(deleteButton());
    fireEvent.click(await screen.findByRole("button", { name: "완전히 삭제" }));
    await waitFor(() => expect(deleteMail).toHaveBeenCalledWith("a1-trash-0"));
  });
});
