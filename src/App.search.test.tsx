import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { searchMails } from "./lib/ipc";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return { ...actual, searchMails: vi.fn(actual.searchMails) };
});

// jsdom은 크기가 0이라 가상화 목록이 행을 그리지 않는다. 모든 행을 그리는 대역으로 바꾼다.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 84,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 84 })),
  }),
}));

describe("검색", () => {
  it("입력하면 잠시 뒤 검색 결과로 바뀌고, Esc로 원래 목록에 돌아온다", async () => {
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    const box = screen.getByRole("searchbox", { name: "메일 검색" });

    fireEvent.change(box, { target: { value: "일정 1" } });
    expect(await screen.findByText("검색: 일정 1")).toBeInTheDocument();
    expect(searchMails).toHaveBeenLastCalledWith(null, "일정 1", "newest");
    expect(await screen.findByText("제주 여행 일정 1")).toBeInTheDocument();
    expect(screen.queryByText("제주 여행 일정 0")).not.toBeInTheDocument();

    fireEvent.keyDown(box, { key: "Escape" });
    expect(await screen.findByText("제주 여행 일정 0")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "통합 받은편지함" })).toBeInTheDocument();
  });

  it("결과가 없으면 안내를 보여준다", async () => {
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    fireEvent.change(screen.getByRole("searchbox", { name: "메일 검색" }), {
      target: { value: "없는단어" },
    });
    expect(await screen.findByText("검색 결과가 없어요")).toBeInTheDocument();
  });
});
