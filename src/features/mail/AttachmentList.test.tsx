import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { revealSavedAttachment, saveAllAttachments, saveAttachment } from "../../lib/ipc";
import { AttachmentList } from "./AttachmentList";

vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  saveAttachment: vi.fn(),
  saveAllAttachments: vi.fn(),
  revealSavedAttachment: vi.fn(() => Promise.resolve()),
}));

const attachments = [
  { id: 1, name: "계약서.pdf", size: "1.2 MB", ext: "PDF" },
  { id: 2, name: "계약서.pdf", size: "384 KB", ext: "PDF" },
];

describe("AttachmentList", () => {
  beforeEach(() => {
    vi.mocked(saveAttachment).mockReset();
    vi.mocked(saveAllAttachments).mockReset();
    vi.mocked(revealSavedAttachment).mockClear();
  });

  it("저장 버튼 라벨에 이름과 크기가 들어가고 누르면 saveAttachment를 부른다", async () => {
    vi.mocked(saveAttachment).mockResolvedValue({ status: "saved", count: 1 });
    render(<AttachmentList mailId="m1" attachments={attachments.slice(0, 1)} />);

    fireEvent.click(screen.getByRole("button", { name: "계약서.pdf 저장 (1.2 MB)" }));

    expect(saveAttachment).toHaveBeenCalledWith("m1", 1);
    expect(await screen.findByText(/저장했어요/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /폴더에서 보기/ }));
    expect(revealSavedAttachment).toHaveBeenCalledWith("m1", 1);
  });

  it("받는 동안 버튼이 잠긴다", async () => {
    let finish: (v: { status: "saved"; count: number }) => void = () => {};
    vi.mocked(saveAttachment).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<AttachmentList mailId="m1" attachments={attachments.slice(0, 1)} />);

    const button = screen.getByRole("button", { name: /계약서.pdf 저장/ });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());

    finish({ status: "saved", count: 1 });
    await screen.findByText(/저장했어요/);
  });

  it("대화상자를 취소하면 아무 문구 없이 원래대로 돌아온다", async () => {
    vi.mocked(saveAttachment).mockResolvedValue({ status: "cancelled" });
    render(<AttachmentList mailId="m1" attachments={attachments.slice(0, 1)} />);
    const button = screen.getByRole("button", { name: /계약서.pdf 저장/ });

    fireEvent.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByText(/저장했어요/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("실패하면 한국어 안내와 다시 시도가 보이고, 다시 시도하면 재요청한다", async () => {
    vi.mocked(saveAttachment)
      .mockRejectedValueOnce({ kind: "network", message: "서버에 연결할 수 없어요." })
      .mockResolvedValueOnce({ status: "saved", count: 1 });
    render(<AttachmentList mailId="m1" attachments={attachments.slice(0, 1)} />);

    fireEvent.click(screen.getByRole("button", { name: /계약서.pdf 저장/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("서버에 연결할 수 없어요.");

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText(/저장했어요/)).toBeInTheDocument();
    expect(saveAttachment).toHaveBeenCalledTimes(2);
  });

  it("오프라인이면 요청하지 않고 안내한다", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(<AttachmentList mailId="m1" attachments={attachments.slice(0, 1)} />);

    fireEvent.click(screen.getByRole("button", { name: /계약서.pdf 저장/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("인터넷에 연결되어 있지 않아");
    expect(saveAttachment).not.toHaveBeenCalled();
    online.mockRestore();
  });

  it("이름이 같은 첨부 둘이 각각 따로 동작한다", async () => {
    vi.mocked(saveAttachment).mockResolvedValue({ status: "saved", count: 1 });
    render(<AttachmentList mailId="m1" attachments={attachments} />);

    fireEvent.click(screen.getByRole("button", { name: "계약서.pdf 저장 (384 KB)" }));

    expect(saveAttachment).toHaveBeenCalledWith("m1", 2);
    expect(await screen.findAllByText(/저장했어요/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "계약서.pdf 저장 (1.2 MB)" })).toBeEnabled();
  });

  it("첨부가 둘 이상이면 모두 저장이 보이고 saveAllAttachments를 부른다", async () => {
    vi.mocked(saveAllAttachments).mockResolvedValue({ status: "saved", count: 2 });
    render(<AttachmentList mailId="m1" attachments={attachments} />);

    fireEvent.click(screen.getByRole("button", { name: /모두 저장/ }));

    expect(saveAllAttachments).toHaveBeenCalledWith("m1");
    expect(await screen.findByText(/2개를 저장했어요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "폴더에서 보기" }));
    expect(revealSavedAttachment).toHaveBeenCalledWith("m1", undefined);
  });

  it("첨부가 하나면 모두 저장을 보이지 않는다", () => {
    render(<AttachmentList mailId="m1" attachments={attachments.slice(0, 1)} />);
    expect(screen.queryByRole("button", { name: /모두 저장/ })).toBeNull();
  });
});
