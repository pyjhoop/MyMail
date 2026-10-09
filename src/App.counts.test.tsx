import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { deleteMail, listAccounts, listFolders, type Account } from "./lib/ipc";
import { FAKE_ACCOUNTS, FAKE_FOLDERS } from "./test/fixtures";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    deleteMail: vi.fn(() => Promise.resolve()),
    setRead: vi.fn(() => Promise.resolve()),
    listAccounts: vi.fn(actual.listAccounts),
    listFolders: vi.fn(actual.listFolders),
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 84,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 84 })),
  }),
}));

let unread: Record<string, number>;
const accountsNow = (): Account[] => FAKE_ACCOUNTS.map((a) => ({ ...a, unread: unread[a.id] }));

const rail = () => screen.getByRole("button", { name: /^개인 Gmail/ });
const deleteButton = () =>
  within(screen.getByRole("region", { name: "메일 목록" })).getByRole("button", { name: "삭제" });

describe("삭제와 안 읽은 수", () => {
  beforeEach(() => {
    unread = { a1: 12, a2: 3, a3: 128 };
    vi.mocked(listAccounts).mockReset();
    vi.mocked(listAccounts).mockImplementation(async () => accountsNow());
    vi.mocked(listFolders).mockImplementation(async (accountId) =>
      FAKE_FOLDERS.filter((f) => f.accountId === accountId).map((f) => ({
        ...f,
        unread: unread[accountId],
      })),
    );
    vi.mocked(deleteMail).mockReset();
    vi.mocked(deleteMail).mockImplementation(async (id) => {
      unread[id.split("-")[0]] -= 1;
    });
  });

  it("안 읽은 메일을 지우면 계정 배지가 바로 줄고 그대로 유지된다 (통합 보기)", async () => {
    render(<App />);
    await waitFor(() => expect(rail()).toHaveTextContent("12"));
    fireEvent.click((await screen.findAllByRole("checkbox"))[0]);
    fireEvent.click(deleteButton());

    await waitFor(() => expect(rail()).toHaveTextContent("11"));
    await waitFor(() => expect(deleteMail).toHaveBeenCalledTimes(1));
    // 다시 읽은 값도 같다
    await waitFor(() => expect(rail()).toHaveTextContent("11"));
  });

  it("삭제 중 늦게 도착한 옛 응답은 줄어든 값을 덮지 않는다", async () => {
    let release: (accounts: Account[]) => void = () => undefined;
    const stale = new Promise<Account[]>((resolve) => {
      release = resolve;
    });
    const staleAccounts = accountsNow();
    // 첫 요청(마운트)은 늦게 도착한다. 이후 요청은 바로 응답한다.
    vi.mocked(listAccounts).mockImplementationOnce(() => stale);

    render(<App />);
    fireEvent.click((await screen.findAllByRole("checkbox"))[0]);
    fireEvent.click(deleteButton());
    await waitFor(() => expect(rail()).toHaveTextContent("11"));

    release(staleAccounts); // 옛 값 12
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(rail()).toHaveTextContent("11");
    expect(rail()).not.toHaveTextContent("12");
  });

  it("계정을 고른 보기에서는 폴더 배지도 줄어든다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^개인 Gmail/ }));
    await screen.findByRole("button", { name: /^받은편지함\s*12$/ });
    fireEvent.click((await screen.findAllByRole("checkbox"))[0]);
    fireEvent.click(deleteButton());

    await screen.findByRole("button", { name: /^받은편지함\s*11$/ });
  });
});
