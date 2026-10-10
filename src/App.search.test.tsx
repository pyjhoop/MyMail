import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "./App";
import { searchMailsPage } from "./lib/ipc";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return { ...actual, searchMailsPage: vi.fn(actual.searchMailsPage) };
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
    expect(await screen.findByText("‘일정 1’ 검색 결과 · 1개")).toBeInTheDocument();
    await waitFor(() => expect(searchMailsPage).toHaveBeenLastCalledWith(null, "일정 1", "newest"));
    // 제목 안의 검색어는 <mark>로 강조되어 글이 여러 조각으로 나뉜다.
    // 검색어는 공백 단위로 나뉘어 "일정"과 "1"이 각각 강조된다.
    const marks = await screen.findAllByText((_, el) => el?.tagName === "MARK");
    expect(marks.map((m) => m.textContent)).toEqual(["일정", "1"]);
    expect(marks[0].parentElement).toHaveTextContent("제주 여행 일정 1");
    expect(screen.queryByText("제주 여행 일정 0")).not.toBeInTheDocument();

    // 첫 Esc는 추천 창만 닫고, 한 번 더 누르면 입력을 지워 원래 목록으로 돌아온다.
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(await screen.findByText("제주 여행 일정 0")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "통합 받은편지함" })).toBeInTheDocument();
  });

  it("목록 끝에 닿으면 다음 페이지를 이어 받아 붙인다", async () => {
    const row = (id: string, subject: string) => ({
      id,
      accountId: "a1",
      folderId: "a1-inbox",
      sender: "김도윤",
      senderEmail: "doyun.kim@gmail.com",
      subject,
      preview: "미리보기",
      time: "오전 9:00",
      unread: false,
      starred: false,
      hasAttachment: false,
      labels: [],
    });
    vi.mocked(searchMailsPage)
      .mockResolvedValueOnce({
        mails: [row("p1", "여행 첫째")],
        total: 2,
        totalCapped: false,
        nextCursor: "c1",
      })
      .mockResolvedValueOnce({
        mails: [row("p2", "여행 둘째")],
        total: 0,
        totalCapped: false,
      });
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    fireEvent.change(screen.getByRole("searchbox", { name: "메일 검색" }), {
      target: { value: "여행" },
    });
    const subject = (text: string) => (_: string, el: Element | null) =>
      el?.tagName === "SPAN" && el.textContent === text;
    expect(await screen.findByText(subject("여행 둘째"))).toBeInTheDocument();
    expect(screen.getByText(subject("여행 첫째"))).toBeInTheDocument();
    expect(searchMailsPage).toHaveBeenCalledWith(null, "여행", "newest", "c1");
    // 전체 건수는 첫 페이지 값을 그대로 쓴다.
    expect(screen.getByText("‘여행’ 검색 결과 · 2개")).toBeInTheDocument();
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
