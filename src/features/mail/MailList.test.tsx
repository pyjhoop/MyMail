import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FAKE_ACCOUNTS } from "../../lib/fakeData";
import { MailList, type ListStatus } from "./MailList";
import type { LoadError } from "../../lib/ipc";

const renderList = (status: ListStatus, error?: LoadError) =>
  render(
    <MailList
      title="받은편지함"
      status={status}
      error={error}
      mails={[]}
      accounts={FAKE_ACCOUNTS}
      showAccount={false}
      selectedId={null}
      onSelect={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );

describe("MailList 상태", () => {
  it("로딩 중에는 스켈레톤을 보여준다", () => {
    renderList("loading");
    expect(screen.getByRole("status", { name: "불러오는 중" })).toBeInTheDocument();
  });

  it("메일이 없으면 빈 폴더 안내를 보여준다", () => {
    renderList("ready");
    expect(screen.getByText("빈 폴더")).toBeInTheDocument();
  });

  it("네트워크 오류는 오프라인 안내, 인증 오류는 앱 비밀번호 안내를 보여준다", () => {
    const { unmount } = renderList("error", { kind: "network", message: "x" });
    expect(screen.getByText("오프라인")).toBeInTheDocument();
    unmount();
    renderList("error", { kind: "auth", message: "x" });
    expect(screen.getByText("앱 비밀번호를 다시 입력해 주세요")).toBeInTheDocument();
  });

  it("알 수 없는 오류는 메시지와 다시 시도 버튼을 보여준다", () => {
    renderList("error", { kind: "unknown", message: "서버 응답 없음" });
    expect(screen.getByText("서버 응답 없음")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });
});
