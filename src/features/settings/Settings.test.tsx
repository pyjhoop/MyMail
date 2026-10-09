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
    appVersion: vi.fn(() => Promise.resolve("0.1.0")),
    checkUpdate: vi.fn(() => Promise.resolve(null)),
    installUpdate: vi.fn(() => Promise.resolve()),
    onUpdateProgress: vi.fn(() => () => {}),
  };
});

const setup = (props: Partial<Parameters<typeof Settings>[0]> = {}) => {
  const onClose = vi.fn();
  const onThemeChange = vi.fn();
  const onSignatureSaved = vi.fn();
  render(
    <Settings
      accounts={FAKE_ACCOUNTS}
      theme="system"
      onThemeChange={onThemeChange}
      onSignatureSaved={onSignatureSaved}
      onClose={onClose}
      {...props}
    />,
  );
  return { onClose, onThemeChange, onSignatureSaved };
};

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

  it("계정 탭에서 서명을 저장한다", async () => {
    const { onSignatureSaved } = setup();
    fireEvent.click(screen.getByRole("tab", { name: "계정" }));
    const save = screen.getAllByRole("button", { name: "서명 저장" })[0];
    expect(save).toBeDisabled();
    fireEvent.change(screen.getAllByLabelText("서명")[0], { target: { value: "준호 드림" } });
    fireEvent.click(save);
    await waitFor(() => expect(ipc.setSignature).toHaveBeenCalledWith("a1", "준호 드림"));
    expect(onSignatureSaved).toHaveBeenCalledWith("a1", "준호 드림");
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
