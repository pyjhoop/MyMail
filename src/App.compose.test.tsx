import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getDraft, listMails, saveDraft, sendDraft, type Draft } from "./lib/ipc";
import { FAKE_MAILS } from "./test/fixtures";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    setRead: vi.fn(() => Promise.resolve()),
    saveDraft: vi.fn(() => Promise.resolve()),
    sendDraft: vi.fn(() => Promise.resolve()),
    discardDraft: vi.fn(() => Promise.resolve()),
    getDraft: vi.fn(),
    suggestAddresses: vi.fn(() => Promise.resolve([])),
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

const composerBody = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "본문" });

describe("작성 연결", () => {
  beforeEach(() => {
    vi.mocked(saveDraft).mockClear();
    vi.mocked(sendDraft).mockClear();
  });

  it("계정을 고르고 '새 메일'을 누르면 그 계정으로 작성기가 열린다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^개인 Gmail/ }));
    fireEvent.click(await screen.findByRole("button", { name: /새 메일/ }));

    expect(await screen.findByRole("region", { name: "메일 작성" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "보내는 계정" })).toHaveValue("a1");
  });

  it("답장: 받는사람·제목·인용이 채워지고, 보내면 작성기가 닫히며 안내가 뜬다", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.click(await screen.findByText("제주 여행 일정 1"));
    await screen.findAllByText("항공권 예매 끝났어!");
    fireEvent.click(screen.getByRole("button", { name: "답장" }));

    expect(await screen.findByRole("region", { name: "메일 작성" })).toBeInTheDocument();
    // 통합 받은편지함에서 연 a2 계정의 메일이므로 a2로 보낸다
    expect(screen.getByRole("combobox", { name: "보내는 계정" })).toHaveValue("a2");
    expect(screen.getByRole("button", { name: "김도윤 삭제" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "제목" })).toHaveValue("Re: 제주 여행 일정 1");
    expect(composerBody().value).not.toContain(">");
    expect(screen.getByRole("button", { name: "인용 펼치기" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(sendDraft).toHaveBeenCalledTimes(1));
    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "a2",
        to: ["김도윤 <doyun.kim@gmail.com>"],
        subject: "Re: 제주 여행 일정 1",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "메일 작성" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("메일을 보냈어요.")).toBeInTheDocument();
  });

  it("전달: 받는사람은 비어 있고 제목에 Fwd:가 붙는다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("제주 여행 일정 0"));
    await screen.findAllByText("항공권 예매 끝났어!");
    fireEvent.click(screen.getByRole("button", { name: "전달" }));

    expect(await screen.findByRole("textbox", { name: "제목" })).toHaveValue(
      "Fwd: 제주 여행 일정 0",
    );
    expect(composerBody().value).toContain("전달된 메일");
  });

  it("임시보관함 목록의 작성 중인 메일을 누르면 저장해 둔 내용으로 작성기가 열린다", async () => {
    const saved: Draft = {
      id: "draft:abc",
      accountId: "a1",
      to: ["doyun@gmail.com"],
      cc: [],
      bcc: [],
      subject: "저장해 둔 제목",
      body: "쓰던 내용",
      quoteHeader: "",
      quoteText: "",
      status: "failed",
      error: "연결 끊김",
      attachments: [{ id: 1, name: "견적.pdf", size: 2000 }],
    };
    vi.mocked(getDraft).mockResolvedValue(saved);
    vi.mocked(listMails).mockResolvedValueOnce({
      nextCursor: undefined,
      mails: [
        {
          ...FAKE_MAILS[0],
          id: "draft:abc",
          subject: "저장해 둔 제목",
          time: "",
        } as never,
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByText("저장해 둔 제목"));

    const sheet = await screen.findByRole("region", { name: "메일 작성" });
    expect(getDraft).toHaveBeenCalledWith("draft:abc");
    expect(within(sheet).getByRole("textbox", { name: "제목" })).toHaveValue("저장해 둔 제목");
    expect(within(sheet).getByText("견적.pdf")).toBeInTheDocument();
    expect(within(sheet).getByRole("alert")).toHaveTextContent("연결 끊김");
  });

  it("작성 팝업이 열려도 읽던 메일이 그대로 남고, 다른 메일을 골라도 작성 내용이 유지된다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("제주 여행 일정 1"));
    await screen.findAllByText("항공권 예매 끝났어!");
    fireEvent.click(screen.getByRole("button", { name: "답장" }));
    const sheet = await screen.findByRole("region", { name: "메일 작성" });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "제목" }), {
      target: { value: "Re: 직접 고친 제목" },
    });

    // 읽던 메일은 그대로
    expect(screen.getAllByText("항공권 예매 끝났어!").length).toBeGreaterThan(0);
    // 다른 메일을 골라도 팝업은 유지
    fireEvent.click(screen.getByText("제주 여행 일정 0"));
    expect(await screen.findByRole("region", { name: "메일 작성" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "제목" })).toHaveValue("Re: 직접 고친 제목");
  });

  it("최소화하면 헤더만 남고 누르면 다시 펼쳐지며, 닫으면 사라진다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^개인 Gmail/ }));
    fireEvent.click(await screen.findByRole("button", { name: /새 메일/ }));
    await screen.findByRole("region", { name: "메일 작성" });

    fireEvent.click(screen.getByRole("button", { name: "작성 최소화" }));
    expect(screen.queryByRole("textbox", { name: "본문" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "메일 작성" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "작성 펼치기" }));
    expect(await screen.findByRole("textbox", { name: "본문" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "작성 닫기" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "메일 작성" })).not.toBeInTheDocument(),
    );
  });

  it("작성 중에 또 열면 확인을 받고, 확인하면 새 메일로 바뀐다", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.click(await screen.findByText("제주 여행 일정 1"));
    await screen.findAllByText("항공권 예매 끝났어!");
    fireEvent.click(screen.getByRole("button", { name: "답장" }));
    await screen.findByRole("region", { name: "메일 작성" });
    fireEvent.change(screen.getByRole("textbox", { name: "제목" }), {
      target: { value: "쓰던 메일" },
    });

    fireEvent.click(screen.getByRole("button", { name: "전달" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    // 취소하면 쓰던 메일 그대로
    await user.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByRole("textbox", { name: "제목" })).toHaveValue("쓰던 메일");

    fireEvent.click(screen.getByRole("button", { name: "전달" }));
    await user.click(await screen.findByRole("button", { name: "저장하고 바꾸기" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "제목" })).toHaveValue("Fwd: 제주 여행 일정 1"),
    );
    // 쓰던 메일은 임시저장됐다
    expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({ subject: "쓰던 메일" }));
  });

  it("최소화한 동안에는 다시 j·k로 메일을 넘길 수 있다", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.click(await screen.findByText("제주 여행 일정 1"));
    await screen.findAllByText("항공권 예매 끝났어!");
    fireEvent.click(screen.getByRole("button", { name: "답장" }));
    await screen.findByRole("region", { name: "메일 작성" });

    const position = () => screen.getByText(/^\d+ \/ \d+$/).textContent;
    const before = position();
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("j");
    expect(position()).toBe(before); // 펼친 동안은 이동하지 않는다

    fireEvent.click(screen.getByRole("button", { name: "작성 최소화" }));
    await user.keyboard("j");
    expect(position()).not.toBe(before);
  });
});
