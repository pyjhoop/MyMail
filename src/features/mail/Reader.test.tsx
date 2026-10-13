import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMail, type MailDetail } from "../../lib/ipc";
import { Reader } from "./Reader";

vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  getMail: vi.fn(),
}));

const mail: MailDetail = {
  id: "m2",
  accountId: "a1",
  folderId: "a1-inbox",
  sender: "박준호",
  senderEmail: "j@test.com",
  subject: "Fwd: 견적",
  preview: "",
  time: "오전 9:00",
  unread: false,
  starred: false,
  hasAttachment: false,
  labels: [],
  to: "나",
  body: ["전달합니다"],
  attachments: [],
  earlier: [
    { id: "m0", sender: "김도윤", initial: "김", preview: "첫 메일", date: "10월 1일" },
    { id: "m1", sender: "이서연", initial: "이", preview: "두 번째", date: "10월 1일" },
  ],
  fullTime: "2026년 10월 2일",
};

describe("Reader 이전 메일", () => {
  beforeEach(() => {
    vi.mocked(getMail).mockReset();
    vi.mocked(getMail).mockImplementation(async (id) => ({
      ...mail,
      id,
      earlier: [],
      body: [`${id} 본문`],
    }));
  });

  const setup = () =>
    render(
      <Reader
        mail={mail}
        loading={false}
        onPrev={() => undefined}
        onNext={() => undefined}
        onCompose={() => undefined}
      />,
    );

  it("누르면 그 자리에서 본문이 펼쳐지고, 다시 누르면 접힌다", async () => {
    setup();
    expect(screen.queryByText("m1 본문")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /이서연/ }));
    expect(await screen.findByText("m1 본문")).toBeInTheDocument();
    expect(screen.queryByText("m0 본문")).toBeNull(); // 같은 날짜의 다른 메일은 그대로

    await userEvent.click(screen.getByRole("button", { name: /이서연/ }));
    expect(screen.queryByText("m1 본문")).toBeNull();
  });

  it("한 번 불러온 본문은 다시 펼칠 때 다시 받지 않는다", async () => {
    setup();
    const button = screen.getByRole("button", { name: /김도윤/ });
    await userEvent.click(button);
    await screen.findByText("m0 본문");
    await userEvent.click(button);
    await userEvent.click(button);
    expect(getMail).toHaveBeenCalledTimes(1);
  });

  it("불러오지 못하면 안내하고, 다시 누르면 재시도한다", async () => {
    vi.mocked(getMail).mockRejectedValueOnce({ kind: "unknown", message: "실패했어요" });
    setup();
    const button = screen.getByRole("button", { name: /김도윤/ });
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("실패했어요");
    await userEvent.click(button);
    await userEvent.click(button);
    expect(await screen.findByText("m0 본문")).toBeInTheDocument();
  });
});
