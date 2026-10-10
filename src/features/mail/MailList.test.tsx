import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FAKE_ACCOUNTS } from "../../test/fixtures";
import { MailList, type ListStatus } from "./MailList";
import type { LoadError, MailSummary } from "../../lib/ipc";

// jsdom은 크기가 0이라 가상화 목록이 행을 그리지 않는다. 모든 행을 그리는 대역으로 바꾼다.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 84,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 84 })),
  }),
}));

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
      checkedIds={new Set()}
      onCheckedChange={vi.fn()}
      onDelete={vi.fn()}
      onRefresh={vi.fn()}
      sort="newest"
      onSortChange={vi.fn()}
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

const MAILS: MailSummary[] = Array.from({ length: 5 }, (_, i) => ({
  id: `m${i}`,
  accountId: "a1",
  folderId: "a1-inbox",
  sender: "보낸이",
  senderEmail: "x@example.com",
  subject: `제목 ${i}`,
  preview: "미리보기",
  time: "오전 9:00",
  unread: false,
  starred: false,
  hasAttachment: false,
  labels: [],
}));

function Harness({ onSelect, onDelete }: { onSelect: (id: string) => void; onDelete: () => void }) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  return (
    <MailList
      title="받은편지함"
      status="ready"
      mails={MAILS}
      accounts={FAKE_ACCOUNTS}
      showAccount={false}
      selectedId={null}
      onSelect={onSelect}
      checkedIds={checked}
      onCheckedChange={setChecked}
      onDelete={onDelete}
      onRefresh={vi.fn()}
      sort="newest"
      onSortChange={vi.fn()}
    />
  );
}

const checkbox = (i: number) =>
  screen.getByRole("checkbox", { name: `보낸이 - 제목 ${i} 선택` }) as HTMLInputElement;

describe("MailList 다중 선택", () => {
  it("선택이 없으면 삭제 버튼이 비활성이다", () => {
    render(<Harness onSelect={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole("button", { name: "삭제" })).toBeDisabled();
  });

  it("체크박스로 선택·해제하고 개수를 보여준다", () => {
    const onDelete = vi.fn();
    render(<Harness onSelect={vi.fn()} onDelete={onDelete} />);

    fireEvent.click(checkbox(1));
    fireEvent.click(checkbox(3));
    expect(screen.getByText("선택 2개")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "삭제" })).toBeEnabled();

    fireEvent.click(checkbox(1));
    expect(screen.getByText("선택 1개")).toBeInTheDocument();
    expect(checkbox(1).checked).toBe(false);
    expect(checkbox(3).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+클릭은 본문을 열지 않고 선택만 바꾼다", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByText("제목 2"), { ctrlKey: true });

    expect(onSelect).not.toHaveBeenCalled();
    expect(checkbox(2).checked).toBe(true);
  });

  it("Shift+클릭은 기준 메일부터 범위를 선택한다", () => {
    render(<Harness onSelect={vi.fn()} onDelete={vi.fn()} />);

    fireEvent.click(checkbox(1));
    fireEvent.click(screen.getByText("제목 3"), { shiftKey: true });

    expect([0, 1, 2, 3, 4].map((i) => checkbox(i).checked)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(screen.getByText("선택 3개")).toBeInTheDocument();
  });

  it("그냥 클릭하면 본문을 열고 선택을 해제한다", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} onDelete={vi.fn()} />);

    fireEvent.click(checkbox(0));
    fireEvent.click(screen.getByText("제목 4"));

    expect(onSelect).toHaveBeenCalledWith("m4");
    expect(screen.queryByText(/^선택 \d+개$/)).not.toBeInTheDocument();
  });
});

describe("MailList 계정 색 막대", () => {
  const renderWith = (showAccount: boolean, mails: MailSummary[]) =>
    render(
      <MailList
        title="받은편지함"
        status="ready"
        mails={mails}
        accounts={FAKE_ACCOUNTS}
        showAccount={showAccount}
        selectedId={null}
        onSelect={vi.fn()}
        checkedIds={new Set()}
        onCheckedChange={vi.fn()}
        onDelete={vi.fn()}
        onRefresh={vi.fn()}
        sort="newest"
        onSortChange={vi.fn()}
      />,
    );
  const two = [
    { ...MAILS[0], id: "x1", accountId: FAKE_ACCOUNTS[0].id },
    { ...MAILS[1], id: "x2", accountId: FAKE_ACCOUNTS[1].id },
  ];

  it("통합 보기에서는 계정 색 세로 막대가 행마다 붙는다", () => {
    renderWith(true, two);
    for (const a of FAKE_ACCOUNTS.slice(0, 2)) {
      const bar = screen.getByRole("img", { name: a.name });
      expect(bar.style.background).toContain(`--account-${a.colorIndex}`);
    }
  });

  it("라벨 칩 색은 라벨 이름으로 정한 색 변수를 쓴다", () => {
    renderWith(false, [{ ...MAILS[0], labels: [{ name: "Work", colorIndex: 5 }] }]);
    const dot = screen.getByText("Work").parentElement!.querySelector("span") as HTMLElement;
    expect(dot.style.background).toBe("var(--account-2)");
  });

  it("라벨이 없는 메일 행에는 칩이 없다", () => {
    renderWith(false, [MAILS[0]]);
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
    expect(document.querySelector("[title='Work']")).toBeNull();
  });

  it("라벨이 여러 개면 최대 2개까지 칩으로 보이고 나머지는 +N이다", () => {
    const labels = ["가족", "여행", "금융", "쇼핑"].map((name) => ({ name, colorIndex: 1 }));
    renderWith(false, [{ ...MAILS[0], labels }]);
    expect(screen.getByText("가족")).toBeInTheDocument();
    expect(screen.getByText("여행")).toBeInTheDocument();
    expect(screen.queryByText("금융")).not.toBeInTheDocument();
    expect(screen.getByText("+2")).toHaveAttribute("title", "금융, 쇼핑");
  });

  it("하위 라벨은 마지막 이름만 칩에 쓰고 전체 이름은 툴팁이다", () => {
    renderWith(false, [{ ...MAILS[0], labels: [{ name: "여행/제주", colorIndex: 1 }] }]);
    expect(screen.getByText("제주").closest("[title]")).toHaveAttribute("title", "여행/제주");
  });

  it("개별 계정·폴더 보기에서는 막대가 없다", () => {
    renderWith(false, two);
    expect(screen.queryByRole("img", { name: FAKE_ACCOUNTS[0].name })).not.toBeInTheDocument();
  });
});
