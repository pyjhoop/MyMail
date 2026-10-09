import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { setRead } from "./lib/ipc";

vi.mock("./lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/ipc")>()),
  setRead: vi.fn(() => Promise.resolve()),
}));

// jsdom은 크기가 0이라 가상화 목록이 행을 그리지 않는다. 모든 행을 그리는 대역으로 바꾼다.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 84,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 84 })),
  }),
}));

describe("읽음 처리", () => {
  beforeEach(() => {
    vi.mocked(setRead).mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const openMail = async (subject: string) => {
    fireEvent.click(await screen.findByText(subject));
    // 본문이 로드될 때까지 기다린다 (목록 미리보기 + 본문 두 곳에 나온다)
    await screen.findAllByText("항공권 예매 끝났어!");
  };

  it("1초 전에 다른 메일을 고르면 읽음 처리하지 않는다", async () => {
    render(<App />);
    await openMail("제주 여행 일정 0");

    await act(() => vi.advanceTimersByTimeAsync(900));
    fireEvent.click(await screen.findByText("제주 여행 일정 1"));
    await act(() => vi.advanceTimersByTimeAsync(900));

    expect(setRead).not.toHaveBeenCalledWith("a1-inbox-0", true);
  });

  it("1초가 지나면 한 번만 읽음 처리한다", async () => {
    render(<App />);
    await openMail("제주 여행 일정 0");

    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(setRead).toHaveBeenCalledTimes(1);
    expect(setRead).toHaveBeenCalledWith("a1-inbox-0", true);
  });
});
