import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { listMails, searchMailsPage, searchScopeCounts } from "./lib/ipc";
import type { MailSummary } from "./lib/ipc";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    listMails: vi.fn(actual.listMails),
    searchMailsPage: vi.fn(actual.searchMailsPage),
    searchScopeCounts: vi.fn(actual.searchScopeCounts),
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

const row = (id: string, subject: string): MailSummary => ({
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

afterEach(() => {
  vi.mocked(searchMailsPage).mockClear();
  vi.mocked(listMails).mockClear();
});

async function startSearch(value: string) {
  render(<App />);
  await screen.findByText("제주 여행 일정 0");
  fireEvent.change(screen.getByRole("searchbox", { name: "메일 검색" }), {
    target: { value },
  });
  await screen.findByRole("complementary", { name: "검색 범위" });
}

describe("검색 범위 패널", () => {
  it("검색하면 폴더 패널이 검색 범위로 바뀌고 계정별 결과 수를 보여 준다", async () => {
    await startSearch("일정");
    const scope = screen.getByRole("complementary", { name: "검색 범위" });
    expect(within(scope).getByText("검색 범위")).toBeInTheDocument();
    expect(within(scope).getByText(/스팸·휴지통은 제외됩니다/)).toBeInTheDocument();
    await waitFor(() => expect(searchScopeCounts).toHaveBeenCalledWith("일정"));
    // fixtures: 계정 3개에 "제주 여행 일정 N" 한 통씩
    await waitFor(() =>
      expect(within(scope).getByRole("button", { name: /모든 계정/ })).toHaveTextContent("3"),
    );
    expect(screen.queryByRole("complementary", { name: "폴더" })).not.toBeInTheDocument();
  });

  it("계정을 고르면 그 계정으로 다시 검색하고 검색어는 유지한다", async () => {
    await startSearch("일정");
    const scope = screen.getByRole("complementary", { name: "검색 범위" });
    fireEvent.click(within(scope).getByRole("button", { name: /개인 Gmail/ }));
    await waitFor(() => expect(searchMailsPage).toHaveBeenLastCalledWith("a1", "일정", "newest"));
    expect(screen.getByRole("searchbox", { name: "메일 검색" })).toHaveValue("일정");
  });

  it("검색을 지우면 폴더 패널로 돌아온다", async () => {
    await startSearch("일정");
    fireEvent.click(screen.getByRole("button", { name: "검색 지우기" }));
    expect(await screen.findByRole("complementary", { name: "폴더" })).toBeInTheDocument();
  });
});

describe("검색 필터 칩과 기간 밖 안내", () => {
  it("첨부 있음 칩은 검색식에 has:첨부를 넣어 다시 검색한다", async () => {
    await startSearch("일정");
    fireEvent.click(screen.getByRole("button", { name: "첨부 있음" }));
    await waitFor(() =>
      expect(searchMailsPage).toHaveBeenLastCalledWith(null, "일정 has:첨부", "newest"),
    );
    expect(screen.getByRole("searchbox", { name: "메일 검색" })).toHaveValue("일정 has:첨부");
    expect(screen.getByRole("button", { name: "첨부 있음" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("기간을 고르면 after: 날짜가 붙고, 칩의 ×로 해제한다", async () => {
    await startSearch("일정");
    fireEvent.click(screen.getByRole("button", { name: "기간" }));
    fireEvent.click(screen.getByRole("option", { name: "최근 3개월" }));
    await waitFor(() =>
      expect(searchMailsPage).toHaveBeenLastCalledWith(
        null,
        expect.stringMatching(/^일정 after:\d{4}-\d{2}-\d{2}$/),
        "newest",
      ),
    );
    expect(screen.getByText("기간: 최근 3개월")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "기간 필터 해제" }));
    await waitFor(() => expect(searchMailsPage).toHaveBeenLastCalledWith(null, "일정", "newest"));
  });

  it("보낸사람 칩은 검색창에 from:을 넣고 값을 쓰기 전에는 검색하지 않는다", async () => {
    await startSearch("일정");
    const calls = vi.mocked(searchMailsPage).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "보낸사람" }));
    const box = screen.getByRole("searchbox", { name: "메일 검색" });
    expect(box).toHaveValue("일정 from:");
    expect(box).toHaveFocus();
    await new Promise((r) => setTimeout(r, 450)); // 디바운스보다 길게
    expect(vi.mocked(searchMailsPage).mock.calls.length).toBe(calls);
  });

  it("기간 밖 결과가 있으면 안내하고 '기간 필터 해제'로 되돌린다", async () => {
    vi.mocked(searchMailsPage).mockResolvedValueOnce({
      mails: [row("m1", "여행 기록")],
      total: 1,
      totalCapped: false,
      olderCount: 2,
    });
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    // 사용자가 직접 쓴 날짜라 "최근 N개월"로 읽히지 않는다.
    fireEvent.change(screen.getByRole("searchbox", { name: "메일 검색" }), {
      target: { value: "여행 after:2020-01-01" },
    });
    expect(await screen.findByText(/2020-01-01 이전의 결과 2개 더 있음/)).toBeInTheDocument();
    const note = screen.getByText(/더 있음/).closest("p")!;
    fireEvent.click(within(note).getByRole("button", { name: "기간 필터 해제" }));
    await waitFor(() => expect(searchMailsPage).toHaveBeenLastCalledWith(null, "여행", "newest"));
  });
});

describe("열린 메일의 검색어 표시", () => {
  it("본문·제목에 검색어를 강조하고 헤더에 검색어 칩과 계정·폴더를 보여 준다", async () => {
    await startSearch("일정");
    fireEvent.click(
      await screen.findByText(
        (_, el) => el?.tagName === "SPAN" && el.textContent === "제주 여행 일정 0",
      ),
    );
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("제주 여행 일정 0");
    expect(within(heading).getByText("일정").tagName).toBe("MARK");
    expect(screen.getByTitle("검색어")).toHaveTextContent("‘일정’");
    expect(await screen.findByText("개인 Gmail · 받은편지함")).toBeInTheDocument();
  });

  it("검색 중이 아니면 칩이 없다", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByText(
        (_, el) => el?.tagName === "SPAN" && el.textContent === "제주 여행 일정 0",
      ),
    );
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByTitle("검색어")).not.toBeInTheDocument();
  });
});

describe("폴더 목록 페이징", () => {
  it("끝에 닿으면 다음 페이지를 커서로 이어 받는다", async () => {
    vi.mocked(listMails)
      .mockResolvedValueOnce({ mails: [row("p1", "목록 첫째")], nextCursor: "c1" })
      .mockResolvedValueOnce({ mails: [row("p2", "목록 둘째")] });
    render(<App />);
    const subject = (text: string) => (_: string, el: Element | null) =>
      el?.tagName === "SPAN" && el.textContent === text;
    expect(await screen.findByText(subject("목록 둘째"))).toBeInTheDocument();
    expect(screen.getByText(subject("목록 첫째"))).toBeInTheDocument();
    expect(listMails).toHaveBeenCalledWith(null, "", "newest", "c1");
    // 마지막 페이지 뒤에는 더 부르지 않는다.
    const calls = vi.mocked(listMails).mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(listMails).mock.calls.length).toBe(calls);
  });
});
