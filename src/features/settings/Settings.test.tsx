import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FAKE_ACCOUNTS } from "../../test/fixtures";
import * as ipc from "../../lib/ipc";
import { Settings } from "./Settings";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    getAutostart: vi.fn(() => Promise.resolve(false)),
    setAutostart: vi.fn(() => Promise.resolve()),
    setSignature: vi.fn(() => Promise.resolve()),
    setSignReplies: vi.fn(() => Promise.resolve()),
    updateAccount: vi.fn(() => Promise.resolve()),
    reorderAccounts: vi.fn(() => Promise.resolve()),
    removeAccount: vi.fn(() => Promise.resolve()),
    appVersion: vi.fn(() => Promise.resolve("0.1.0")),
    checkUpdate: vi.fn(() => Promise.resolve(null)),
    installUpdate: vi.fn(() => Promise.resolve()),
    onUpdateProgress: vi.fn(() => () => {}),
  };
});

const setup = (props: Partial<Parameters<typeof Settings>[0]> = {}) => {
  const onClose = vi.fn();
  const onThemeChange = vi.fn();
  const onAccountPatch = vi.fn();
  const onAccountsReorder = vi.fn();
  const onAccountRemoved = vi.fn();
  const onAddAccount = vi.fn();
  render(
    <Settings
      accounts={FAKE_ACCOUNTS}
      theme="system"
      onThemeChange={onThemeChange}
      onAccountPatch={onAccountPatch}
      onAccountsReorder={onAccountsReorder}
      onAccountRemoved={onAccountRemoved}
      onAddAccount={onAddAccount}
      onClose={onClose}
      {...props}
    />,
  );
  return {
    onClose,
    onThemeChange,
    onAccountPatch,
    onAccountsReorder,
    onAccountRemoved,
    onAddAccount,
  };
};

const openAccounts = () => fireEvent.click(screen.getByRole("tab", { name: "계정" }));

describe("설정", () => {
  it("시작 시 실행을 켜면 setAutostart(true)를 부른다", async () => {
    setup();
    const box = await screen.findByRole("checkbox", { name: /Windows 시작 시 실행/ });
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.click(box);
    await waitFor(() => expect(ipc.setAutostart).toHaveBeenCalledWith(true));
    await waitFor(() => expect(box).toBeChecked());
  });

  it("테마를 고르면 알린다", () => {
    const { onThemeChange } = setup();
    fireEvent.click(screen.getByRole("tab", { name: "모양" }));
    fireEvent.click(screen.getByRole("radio", { name: "다크" }));
    expect(onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("계정 탭에서 서명을 바꾸고 칸을 벗어나면 저장한다", async () => {
    const { onAccountPatch } = setup();
    openAccounts();
    const box = screen.getByLabelText("서명");
    fireEvent.change(box, { target: { value: "준호 드림" } });
    fireEvent.blur(box);
    await waitFor(() => expect(ipc.setSignature).toHaveBeenCalledWith("a1", "준호 드림"));
    expect(onAccountPatch).toHaveBeenCalledWith("a1", { signature: "준호 드림" });
  });

  it("표시 이름을 바꾸면 저장하고, 비우면 되돌린다", async () => {
    const { onAccountPatch } = setup();
    openAccounts();
    const input = screen.getByLabelText("표시 이름");
    fireEvent.change(input, { target: { value: "회사 메일" } });
    fireEvent.blur(input);
    await waitFor(() => expect(ipc.updateAccount).toHaveBeenCalledWith("a1", "회사 메일", 1));
    expect(onAccountPatch).toHaveBeenCalledWith("a1", {
      name: "회사 메일",
      colorIndex: 1,
      initial: "회",
    });
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);
    expect(input).toHaveValue("개인 Gmail");
    expect(ipc.updateAccount).toHaveBeenCalledTimes(1);
  });

  it("계정 색을 고르면 저장한다", async () => {
    setup();
    openAccounts();
    expect(screen.getByRole("button", { name: "파랑" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "보라" }));
    await waitFor(() => expect(ipc.updateAccount).toHaveBeenCalledWith("a1", "개인 Gmail", 4));
  });

  it("답장·전달에도 서명 넣기를 끈다", async () => {
    const { onAccountPatch } = setup();
    openAccounts();
    fireEvent.click(screen.getByRole("checkbox", { name: "답장·전달에도 서명 넣기" }));
    await waitFor(() => expect(ipc.setSignReplies).toHaveBeenCalledWith("a1", false));
    expect(onAccountPatch).toHaveBeenCalledWith("a1", { signReplies: false });
  });

  it("손잡이에서 아래 방향키로 계정 순서를 바꾼다", async () => {
    const { onAccountsReorder } = setup();
    openAccounts();
    fireEvent.keyDown(screen.getAllByRole("button", { name: "순서 바꾸기" })[0], {
      key: "ArrowDown",
    });
    await waitFor(() => expect(ipc.reorderAccounts).toHaveBeenCalledWith(["a2", "a1", "a3"]));
    expect(onAccountsReorder).toHaveBeenCalledWith(["a2", "a1", "a3"]);
  });

  it("계정 제거는 확인을 거친다", async () => {
    const { onAccountRemoved } = setup();
    openAccounts();
    fireEvent.click(screen.getByRole("button", { name: "계정 제거" }));
    expect(ipc.removeAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    fireEvent.click(screen.getByRole("button", { name: "계정 제거" }));
    fireEvent.click(screen.getByRole("button", { name: "제거" }));
    await waitFor(() => expect(ipc.removeAccount).toHaveBeenCalledWith("a1"));
    expect(onAccountRemoved).toHaveBeenCalledWith("a1");
  });

  it("계정 추가 버튼과 접기·펼치기", () => {
    const { onAddAccount } = setup();
    openAccounts();
    fireEvent.click(screen.getByRole("button", { name: "계정 추가" }));
    expect(onAddAccount).toHaveBeenCalled();
    const head = screen.getAllByRole("button", { expanded: true })[0];
    fireEvent.click(head);
    expect(screen.queryByLabelText("표시 이름")).not.toBeInTheDocument();
  });

  it("위 방향키로 계정을 앞으로 옮긴다", async () => {
    setup();
    openAccounts();
    fireEvent.keyDown(screen.getAllByRole("button", { name: "순서 바꾸기" })[2], {
      key: "ArrowUp",
    });
    await waitFor(() => expect(ipc.reorderAccounts).toHaveBeenCalledWith(["a1", "a3", "a2"]));
  });

  it("단축키 목록을 보여주고 Esc로 닫는다", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("tab", { name: "단축키" }));
    expect(screen.getByText("새 메일")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("업데이트", () => {
  it("업데이트 확인 후 새 버전이 있으면 설치할 수 있다", async () => {
    vi.mocked(ipc.checkUpdate).mockResolvedValueOnce({ version: "0.2.0", notes: null });
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "업데이트 확인" }));
    expect(await screen.findByText(/새 버전 0\.2\.0/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "지금 업데이트" }));
    await waitFor(() => expect(ipc.installUpdate).toHaveBeenCalledTimes(1));
  });

  it("최신이면 안내한다", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "업데이트 확인" }));
    expect(await screen.findByText("최신 버전이에요.")).toBeInTheDocument();
  });
});
