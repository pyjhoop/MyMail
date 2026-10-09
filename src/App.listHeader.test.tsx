import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { listMails, searchMails, syncNow } from "./lib/ipc";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    listMails: vi.fn(actual.listMails),
    searchMails: vi.fn(actual.searchMails),
    syncNow: vi.fn(() => Promise.resolve()),
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

const list = () => within(screen.getByRole("region", { name: "메일 목록" }));
const sortButton = () => list().getByRole("button", { name: /^정렬:/ });
const refreshButton = () => list().getByRole("button", { name: "새로고침" });

beforeEach(() => {
  localStorage.clear();
  vi.mocked(syncNow).mockReset();
  vi.mocked(syncNow).mockResolvedValue(undefined);
  vi.mocked(listMails).mockClear();
  vi.mocked(searchMails).mockClear();
});

describe("메일 목록 정렬", () => {
  it("기본은 최신순이고, 메뉴에서 고르면 그 정렬로 다시 불러오고 라벨이 바뀐다", async () => {
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    expect(sortButton()).toHaveAccessibleName("정렬: 최신순");
    await waitFor(() => expect(listMails).toHaveBeenLastCalledWith(null, "", "newest"));

    fireEvent.click(sortButton());
    fireEvent.click(screen.getByRole("menuitemradio", { name: "오래된순" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(sortButton()).toHaveAccessibleName("정렬: 오래된순");
    await waitFor(() => expect(listMails).toHaveBeenLastCalledWith(null, "", "oldest"));
  });

  it("검색 결과에도 같은 정렬을 쓴다", async () => {
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    fireEvent.click(sortButton());
    fireEvent.click(screen.getByRole("menuitemradio", { name: "제목순" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "메일 검색" }), {
      target: { value: "일정 1" },
    });
    await screen.findByText("검색: 일정 1");
    await waitFor(() => expect(searchMails).toHaveBeenLastCalledWith(null, "일정 1", "subject"));
  });

  it("선택을 저장하고 다음 실행 때 복원한다", async () => {
    const first = render(<App />);
    await screen.findByText("제주 여행 일정 0");
    fireEvent.click(sortButton());
    fireEvent.click(screen.getByRole("menuitemradio", { name: "안 읽음 먼저" }));
    expect(localStorage.getItem("mymail.mailSort")).toBe("unread");
    first.unmount();

    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    expect(sortButton()).toHaveAccessibleName("정렬: 안 읽음 먼저");
    await waitFor(() => expect(listMails).toHaveBeenLastCalledWith(null, "", "unread"));
  });

  it("저장된 값이 알 수 없는 값이면 최신순으로 시작한다", async () => {
    localStorage.setItem("mymail.mailSort", "received_at; DROP");
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    expect(sortButton()).toHaveAccessibleName("정렬: 최신순");
  });

  it("Esc로 메뉴를 닫는다", async () => {
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    fireEvent.click(sortButton());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("메일 목록 새로고침", () => {
  it("누르면 syncNow를 부르고, 진행 중에는 비활성이며, 끝나면 목록을 다시 읽는다", async () => {
    let finish: () => void = () => undefined;
    vi.mocked(syncNow).mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    const before = vi.mocked(listMails).mock.calls.length;

    fireEvent.click(refreshButton());
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledWith(null, undefined);
    expect(refreshButton()).toBeDisabled();
    expect(refreshButton()).toHaveAttribute("aria-busy", "true");

    // 연타해도 다시 시작하지 않는다
    fireEvent.click(refreshButton());
    expect(syncNow).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    expect(refreshButton()).toHaveAttribute("aria-busy", "false");
    await waitFor(() => expect(vi.mocked(listMails).mock.calls.length).toBeGreaterThan(before));
  });

  it("실패하면 한국어 안내를 보여주고 다시 누를 수 있다", async () => {
    vi.mocked(syncNow).mockRejectedValueOnce({ kind: "network", message: "x" });
    render(<App />);
    await screen.findByText("제주 여행 일정 0");

    fireEvent.click(refreshButton());
    expect(await screen.findByText(/인터넷에 연결되어 있지 않아/)).toBeInTheDocument();
    await waitFor(() => expect(refreshButton()).toBeEnabled());

    fireEvent.click(refreshButton());
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(/인터넷에 연결되어 있지 않아/)).not.toBeInTheDocument(),
    );
  });

  it("인증 오류는 앱 비밀번호 안내를 보여준다", async () => {
    vi.mocked(syncNow).mockRejectedValueOnce({ kind: "auth", message: "x" });
    render(<App />);
    await screen.findByText("제주 여행 일정 0");
    fireEvent.click(refreshButton());
    expect(await screen.findByText(/앱 비밀번호를 확인해 주세요/)).toBeInTheDocument();
  });

  it("F5와 Ctrl+R은 웹뷰 새로고침 대신 동기화를 시작한다", async () => {
    render(<App />);
    await screen.findByText("제주 여행 일정 0");

    const f5 = new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
    window.dispatchEvent(f5);
    expect(f5.defaultPrevented).toBe(true);
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refreshButton()).toBeEnabled());

    const ctrlR = new KeyboardEvent("keydown", {
      key: "r",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ctrlR);
    expect(ctrlR.defaultPrevented).toBe(true);
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(2));
  });
});
