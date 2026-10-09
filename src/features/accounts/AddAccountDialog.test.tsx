import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_ACCOUNTS } from "../../test/fixtures";
import { AddAccountDialog } from "./AddAccountDialog";

const addAccount = vi.hoisted(() => vi.fn());
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  addAccount,
}));

beforeEach(() => {
  addAccount.mockReset();
});

const fill = async () => {
  await userEvent.type(screen.getByLabelText("아이디"), "junho_p");
  await userEvent.type(screen.getByLabelText("비밀번호 또는 애플리케이션 비밀번호"), "app-pw");
};

describe("AddAccountDialog", () => {
  it("입력이 비어 있으면 연결할 수 없다", () => {
    render(<AddAccountDialog onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(screen.getByRole("button", { name: "연결" })).toBeDisabled();
  });

  it("연결에 성공하면 추가된 계정을 알린다", async () => {
    addAccount.mockResolvedValue(FAKE_ACCOUNTS[2]);
    const onAdded = vi.fn();
    render(<AddAccountDialog onClose={vi.fn()} onAdded={onAdded} />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "연결" }));
    expect(addAccount).toHaveBeenCalledWith({
      provider: "naver",
      email: "junho_p@naver.com",
      password: "app-pw",
    });
    expect(onAdded).toHaveBeenCalledWith(FAKE_ACCOUNTS[2]);
  });

  it("로그인에 실패하면 안내를 보여주고 다시 시도할 수 있다", async () => {
    addAccount.mockImplementation(() =>
      Promise.reject({ kind: "auth", message: "IMAP 사용이 켜져 있는지 확인해 주세요." }),
    );
    const onAdded = vi.fn();
    render(<AddAccountDialog onClose={vi.fn()} onAdded={onAdded} />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "연결" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("로그인하지 못했어요");
    expect(screen.getByRole("alert")).toHaveTextContent("IMAP 사용이 켜져 있는지");
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeEnabled();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("Gmail을 고르면 Gmail 주소와 앱 비밀번호 안내로 바뀌고 gmail로 연결한다", async () => {
    addAccount.mockResolvedValue(FAKE_ACCOUNTS[0]);
    render(<AddAccountDialog onClose={vi.fn()} onAdded={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: "Gmail" }));
    expect(screen.getByRole("heading")).toHaveTextContent("Gmail 계정 연결");
    expect(screen.getByText(/앱 비밀번호 16자리/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Gmail 주소"), "junho.park");
    await userEvent.type(screen.getByLabelText("앱 비밀번호"), "abcdabcdabcdabcd");
    await userEvent.click(screen.getByRole("button", { name: "연결" }));
    expect(addAccount).toHaveBeenCalledWith({
      provider: "gmail",
      email: "junho.park@gmail.com",
      password: "abcdabcdabcdabcd",
    });
  });
});
