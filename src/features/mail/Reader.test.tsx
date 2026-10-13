import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MailDetail } from "../../lib/ipc";
import { Reader } from "./Reader";

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
  it("이전 메일을 누르면 그 메일의 id로 연다 (같은 날짜여도 각각)", async () => {
    const onOpenMail = vi.fn();
    render(
      <Reader
        mail={mail}
        loading={false}
        onPrev={() => undefined}
        onNext={() => undefined}
        onCompose={() => undefined}
        onOpenMail={onOpenMail}
      />,
    );
    await userEvent.click(screen.getByText("두 번째"));
    expect(onOpenMail).toHaveBeenCalledWith("m1");
    await userEvent.click(screen.getByText("첫 메일"));
    expect(onOpenMail).toHaveBeenLastCalledWith("m0");
  });
});
