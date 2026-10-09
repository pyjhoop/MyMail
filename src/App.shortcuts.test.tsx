import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { deleteMail } from "./lib/ipc";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    deleteMail: vi.fn(() => Promise.resolve()),
    setRead: vi.fn(() => Promise.resolve()),
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

const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { key, ...init });

describe("키보드 단축키", () => {
  beforeEach(() => {
    vi.mocked(deleteMail).mockClear();
  });

  it("j·k로 메일을 오가고 r로 답장 작성기를 연다", async () => {
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    press("j");
    expect(await screen.findByText("1 / 3")).toBeInTheDocument();
    press("j");
    expect(await screen.findByText("2 / 3")).toBeInTheDocument();
    press("k");
    expect(await screen.findByText("1 / 3")).toBeInTheDocument();

    await screen.findAllByText("항공권 예매 끝났어!");
    press("r");
    expect(await screen.findByRole("region", { name: "메일 작성" })).toBeInTheDocument();
  });

  it("c는 새 메일, /는 검색창 포커스", async () => {
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    press("/");
    expect(screen.getByRole("searchbox", { name: "메일 검색" })).toHaveFocus();

    // 입력 중에는 한 글자 단축키가 가로채지 않는다
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "메일 검색" }), { key: "c" });
    expect(screen.queryByRole("region", { name: "메일 작성" })).not.toBeInTheDocument();

    press("c");
    expect(await screen.findByRole("region", { name: "메일 작성" })).toBeInTheDocument();
  });

  it("#는 열린 메일을 삭제하고, Ctrl+숫자는 계정을 바꾼다", async () => {
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    press("#");
    expect(deleteMail).not.toHaveBeenCalled(); // 열린 메일이 없으면 아무 일도 없다

    press("j");
    await screen.findByText("1 / 3", undefined, { timeout: 4000 });
    press("#");
    await waitFor(() => expect(deleteMail).toHaveBeenCalledWith("a1-inbox-0"), { timeout: 4000 });

    press("2", { ctrlKey: true });
    expect(
      await screen.findByRole("heading", { name: "받은편지함" }, { timeout: 4000 }),
    ).toBeInTheDocument();
    press("1", { ctrlKey: true });
    expect(
      await screen.findByRole("heading", { name: "통합 받은편지함" }, { timeout: 4000 }),
    ).toBeInTheDocument();
  });
});
