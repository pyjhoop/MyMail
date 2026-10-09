import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { listAccounts, listFolders, setRead } from "./lib/ipc";
import { FAKE_ACCOUNTS, FAKE_FOLDERS } from "./test/fixtures";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    setRead: vi.fn(() => Promise.resolve()),
    listAccounts: vi.fn(actual.listAccounts),
    listFolders: vi.fn(actual.listFolders),
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

/** 백엔드처럼 안 읽은 수를 기억하는 대역. `setRead`가 성공하면 수가 줄어든다. */
let unread: Record<string, number>;
function backend() {
  unread = { a1: 12, a2: 3, a3: 128 };
  vi.mocked(listAccounts).mockImplementation(async () =>
    FAKE_ACCOUNTS.map((a) => ({ ...a, unread: unread[a.id] })),
  );
  vi.mocked(listFolders).mockImplementation(async (accountId) =>
    FAKE_FOLDERS.filter((f) => f.accountId === accountId).map((f) => ({
      ...f,
      unread: unread[accountId],
    })),
  );
  vi.mocked(setRead).mockImplementation(async (id, read) => {
    unread[id.split("-")[0]] += read ? -1 : 1;
  });
}

const railBadge = (name: RegExp) => screen.getByRole("button", { name });
const rowDots = () => screen.queryAllByLabelText("안 읽음");

describe("읽음 처리", () => {
  beforeEach(() => {
    vi.mocked(setRead).mockReset();
    backend();
  });

  it("메일을 고르면 지연 없이 한 번 읽음 처리하고 목록·안 읽은 수가 바로 바뀐다", async () => {
    render(<App />);
    await waitFor(() => expect(railBadge(/^개인 Gmail/)).toHaveTextContent("12"));
    const dotsBefore = (await screen.findAllByLabelText("안 읽음")).length;

    fireEvent.click(await screen.findByText("제주 여행 일정 0"));

    // 본문을 기다리지 않고 같은 틱에 호출된다.
    expect(setRead).toHaveBeenCalledTimes(1);
    expect(setRead).toHaveBeenCalledWith("a1-inbox-0", true);
    expect(rowDots()).toHaveLength(dotsBefore - 1);
    expect(railBadge(/^개인 Gmail/)).toHaveTextContent("11");
    await waitFor(() => expect(railBadge(/^개인 Gmail/)).toHaveTextContent("11"));
  });

  it("계정을 고른 보기에서는 폴더의 안 읽은 수도 줄어든다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^개인 Gmail/ }));
    const inbox = await screen.findByRole("button", { name: /^받은편지함\s*12$/ });
    expect(inbox).toBeInTheDocument();

    fireEvent.click(await screen.findByText("제주 여행 일정 0"));

    expect(screen.getByRole("button", { name: /^받은편지함\s*11$/ })).toBeInTheDocument();
  });

  it("호출이 실패하면 안 읽음으로 되돌린다", async () => {
    vi.mocked(setRead).mockRejectedValueOnce(new Error("실패"));
    render(<App />);
    await waitFor(() => expect(railBadge(/^개인 Gmail/)).toHaveTextContent("12"));
    const dotsBefore = (await screen.findAllByLabelText("안 읽음")).length;

    fireEvent.click(await screen.findByText("제주 여행 일정 0"));

    await waitFor(() => expect(rowDots()).toHaveLength(dotsBefore));
    await waitFor(() => expect(railBadge(/^개인 Gmail/)).toHaveTextContent("12"));
  });

  it("이미 읽은 메일은 다시 호출하지 않는다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("제주 여행 일정 0"));
    await waitFor(() => expect(setRead).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByText("제주 여행 일정 1"));
    fireEvent.click(screen.getByText("제주 여행 일정 0"));
    await waitFor(() => expect(setRead).toHaveBeenCalledTimes(2));

    expect(setRead).toHaveBeenCalledWith("a1-inbox-0", true);
    expect(setRead).toHaveBeenCalledWith("a2-inbox-0", true);
  });

  it("방향키로 훑어도 지나가는 메일을 읽음 처리한다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("제주 여행 일정 0"));
    await waitFor(() => expect(setRead).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document.body, { key: "j" });

    await waitFor(() => expect(setRead).toHaveBeenCalledWith("a2-inbox-0", true));
    const list = screen.getByRole("region", { name: "메일 목록" });
    expect(within(list).queryAllByLabelText("안 읽음")).toHaveLength(1);
  });
});
