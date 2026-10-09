import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDraftAttachment,
  discardDraft,
  removeDraftAttachment,
  saveDraft,
  sendDraft,
  suggestAddresses,
  type Draft,
} from "../../lib/ipc";
import { FAKE_ACCOUNTS } from "../../test/fixtures";
import { Composer, type ComposeInit } from "./Composer";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    saveDraft: vi.fn(() => Promise.resolve()),
    sendDraft: vi.fn(() => Promise.resolve()),
    discardDraft: vi.fn(() => Promise.resolve()),
    addDraftAttachment: vi.fn(() => Promise.resolve(7)),
    removeDraftAttachment: vi.fn(() => Promise.resolve()),
    suggestAddresses: vi.fn(() => Promise.resolve([])),
    setSignature: vi.fn(() => Promise.resolve()),
  };
});

const accounts = FAKE_ACCOUNTS.map((a, i) => ({ ...a, signature: i === 0 ? "박준호 드림" : "" }));

const draft = (patch: Partial<Draft> = {}): Draft => ({
  id: "draft:t1",
  accountId: "a1",
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  body: "",
  status: "draft",
  error: null,
  attachments: [],
  ...patch,
});

const setup = (init: Partial<ComposeInit> = {}) => {
  const onClose = vi.fn();
  const onSignatureSaved = vi.fn();
  render(
    <Composer
      accounts={accounts}
      init={{ draft: draft(), seed: { subject: "", body: "" }, ...init }}
      onClose={onClose}
      onSignatureSaved={onSignatureSaved}
    />,
  );
  return { onClose, onSignatureSaved };
};

const toInput = () => screen.getByRole("combobox", { name: "받는사람" });
const sendButton = () => screen.getByRole("button", { name: /보내기|보내는 중/ });

describe("작성기", () => {
  beforeEach(() => {
    vi.mocked(saveDraft).mockClear();
    vi.mocked(sendDraft).mockReset().mockResolvedValue(undefined);
    vi.mocked(discardDraft).mockClear();
    vi.mocked(addDraftAttachment).mockClear();
    vi.mocked(suggestAddresses).mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("주소를 입력하고 Enter를 누르면 칩이 되고, 보내면 저장 뒤 발송하고 닫는다", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.type(toInput(), "doyun@gmail.com{Enter}");
    expect(screen.getByRole("button", { name: "doyun@gmail.com 삭제" })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "제목" }), "안녕");
    await user.click(sendButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledWith("sent"));
    expect(saveDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "draft:t1", to: ["doyun@gmail.com"], subject: "안녕" }),
    );
    expect(sendDraft).toHaveBeenCalledWith("draft:t1");
    expect(vi.mocked(saveDraft).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendDraft).mock.invocationCallOrder[0],
    );
  });

  it("입력창에 남은 주소도 보낼 때 받는사람으로 확정한다 (Ctrl+Enter)", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.type(toInput(), "a@b.com{Control>}{Enter}{/Control}");
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("sent"));
    expect(saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({ to: ["a@b.com"] }));
  });

  it("받는사람이 없거나 주소가 틀리면 보내지 않고 알린다", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(sendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("받는사람을 입력해 주세요");

    await user.type(toInput(), "김도윤{Enter}");
    await user.click(sendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("올바르지 않은 메일 주소");
    expect(sendDraft).not.toHaveBeenCalled();
  });

  it("발송에 실패하면 오류를 보이고 '다시 보내기'로 바뀐다", async () => {
    vi.mocked(sendDraft).mockRejectedValueOnce({ kind: "network", message: "연결 끊김" });
    const user = userEvent.setup();
    const { onClose } = setup({ draft: draft({ to: ["a@b.com"] }) });
    await user.click(sendButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("메일을 보내지 못했어요. 연결 끊김");
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "다시 보내기" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("sent"));
  });

  it("보내지 못한 채 남은 메일을 열면 이유와 다시 보내기를 보여준다", () => {
    setup({ draft: draft({ to: ["a@b.com"], status: "failed", error: "연결 끊김" }) });
    expect(screen.getByRole("alert")).toHaveTextContent("이전에 보내지 못했어요. 연결 끊김");
    expect(screen.getByRole("button", { name: "다시 보내기" })).toBeInTheDocument();
  });

  it("입력이 멈추고 1.5초 뒤에 임시저장한다", async () => {
    vi.useFakeTimers();
    setup();
    expect(saveDraft).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "제목" }), { target: { value: "제" } });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    fireEvent.change(screen.getByRole("textbox", { name: "제목" }), { target: { value: "제주" } });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(saveDraft).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({ subject: "제주" }));
    expect(screen.getByRole("status")).toHaveTextContent("임시저장됨");
  });

  it("처음 채워 준 내용 그대로 닫으면 저장하지 않고 버린다", async () => {
    const user = userEvent.setup();
    const { onClose } = setup({
      draft: draft({ subject: "Re: x", body: "\n\n인용" }),
      seed: { subject: "Re: x", body: "\n\n인용" },
    });
    await user.click(screen.getByRole("button", { name: "작성 닫기" }));
    expect(discardDraft).toHaveBeenCalledWith("draft:t1");
    expect(saveDraft).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("discarded");
  });

  it("내용이 있으면 저장하고 닫는다", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.type(screen.getByRole("textbox", { name: "본문" }), "메모");
    await user.click(screen.getByRole("button", { name: "작성 닫기" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("kept"));
    expect(saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({ body: "메모" }));
    expect(discardDraft).not.toHaveBeenCalled();
  });

  it("저장해 둔 임시 메일은 열기만 하고 닫아도 지워지지 않는다", async () => {
    const user = userEvent.setup();
    const { onClose } = setup({ draft: draft({ to: ["a@b.com"], subject: "저장본" }) });
    await user.click(screen.getByRole("button", { name: "작성 닫기" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("kept"));
    expect(discardDraft).not.toHaveBeenCalled();
  });

  it("휴지통 버튼은 임시 메일을 버린다", async () => {
    const user = userEvent.setup();
    const { onClose } = setup({ draft: draft({ to: ["a@b.com"] }) });
    await user.click(screen.getByRole("button", { name: "임시보관 삭제" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("discarded"));
    expect(discardDraft).toHaveBeenCalledWith("draft:t1");
  });

  it("글자를 입력하면 추천이 뜨고 Enter로 고른다", async () => {
    vi.mocked(suggestAddresses).mockResolvedValue([
      { name: "김도윤", email: "doyun@gmail.com" },
      { name: "", email: "doyun2@naver.com" },
    ]);
    const user = userEvent.setup();
    setup();
    await user.type(toInput(), "도윤");
    expect(await screen.findByRole("option", { name: /김도윤/ })).toBeInTheDocument();
    expect(suggestAddresses).toHaveBeenLastCalledWith("도윤");

    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(screen.getByRole("button", { name: "김도윤 삭제" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Esc는 추천만 닫는다", async () => {
    vi.mocked(suggestAddresses).mockResolvedValue([{ name: "김도윤", email: "doyun@gmail.com" }]);
    const user = userEvent.setup();
    setup();
    await user.type(toInput(), "도");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Backspace로 마지막 칩을 지우고, 붙여넣은 여러 주소는 한꺼번에 칩이 된다", async () => {
    const user = userEvent.setup();
    setup({ draft: draft({ to: ["a@b.com", "c@d.com"] }) });
    toInput().focus();
    await user.keyboard("{Backspace}");
    expect(screen.queryByRole("button", { name: "c@d.com 삭제" })).not.toBeInTheDocument();

    await user.paste("x@y.com, z@w.com");
    expect(screen.getByRole("button", { name: "x@y.com 삭제" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "z@w.com 삭제" })).toBeInTheDocument();
  });

  it("참조·숨은참조 입력은 버튼을 눌러야 나타난다", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByRole("combobox", { name: "참조" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "참조" }));
    expect(screen.getByRole("combobox", { name: "참조" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "숨은참조" }));
    expect(screen.getByRole("combobox", { name: "숨은참조" })).toBeInTheDocument();
  });

  it("파일을 첨부하면 먼저 저장하고 올린 뒤 목록에 보이고, 삭제할 수 있다", async () => {
    const user = userEvent.setup();
    setup();
    const file = new File(["hello"], "견적.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText(/파일 첨부/), file);

    expect(await screen.findByText("견적.pdf")).toBeInTheDocument();
    expect(addDraftAttachment).toHaveBeenCalledWith("draft:t1", file);
    expect(vi.mocked(saveDraft).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(addDraftAttachment).mock.invocationCallOrder[0],
    );

    await user.click(screen.getByRole("button", { name: "견적.pdf 첨부 삭제" }));
    await waitFor(() => expect(screen.queryByText("견적.pdf")).not.toBeInTheDocument());
    expect(removeDraftAttachment).toHaveBeenCalledWith("draft:t1", 7);
  });

  it("서비스 한도를 넘어 거절되면 이유를 보여준다", async () => {
    vi.mocked(addDraftAttachment).mockRejectedValueOnce({
      kind: "unknown",
      message: "첨부 용량이 너무 커요. 이 계정은 메일 한 통에 최대 25MB까지 보낼 수 있어요",
    });
    const user = userEvent.setup();
    setup();
    await user.upload(screen.getByLabelText(/파일 첨부/), new File(["x"], "큰파일.zip"));
    expect(await screen.findByRole("alert")).toHaveTextContent("최대 25MB");
    expect(screen.queryByText("큰파일.zip", { selector: "span" })).not.toBeInTheDocument();
  });

  it("보내는 계정을 바꾸면 본문의 서명도 그 계정 것으로 바뀐다", async () => {
    const user = userEvent.setup();
    setup({ draft: draft({ body: "\n\n-- \n박준호 드림" }) });
    await user.selectOptions(screen.getByRole("combobox", { name: "보내는 계정" }), "a2");
    expect(screen.getByRole("textbox", { name: "본문" })).toHaveValue("");
    await user.selectOptions(screen.getByRole("combobox", { name: "보내는 계정" }), "a1");
    expect(screen.getByRole("textbox", { name: "본문" })).toHaveValue("\n\n-- \n박준호 드림");
  });

  it("서명을 편집해 저장하면 본문과 계정 목록에 반영된다", async () => {
    const user = userEvent.setup();
    const { onSignatureSaved } = setup({ draft: draft({ body: "\n\n-- \n박준호 드림" }) });
    await user.click(screen.getByRole("button", { name: "서명 편집" }));
    const box = screen.getByRole("textbox", { name: /서명$/ });
    await user.clear(box);
    await user.type(box, "Junho");
    await user.click(screen.getByRole("button", { name: "서명 저장" }));

    expect(onSignatureSaved).toHaveBeenCalledWith("a1", "Junho");
    expect(screen.getByRole("textbox", { name: "본문" })).toHaveValue("\n\n-- \nJunho");
  });
});
