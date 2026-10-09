import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncProgress } from "../../lib/ipc";
import { FAKE_ACCOUNTS } from "../../test/fixtures";
import { AddAccountDialog } from "./AddAccountDialog";

const addAccount = vi.hoisted(() => vi.fn());
const progressListeners = vi.hoisted(() => new Set<(p: SyncProgress) => void>());
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  addAccount,
  onSyncProgress: (cb: (p: SyncProgress) => void) => {
    progressListeners.add(cb);
    return () => progressListeners.delete(cb);
  },
}));

const emit = (p: Partial<SyncProgress> & { done: number; total: number }) =>
  act(() => {
    progressListeners.forEach((cb) => cb({ accountId: "a3", error: null, ...p }));
  });

beforeEach(() => {
  addAccount.mockReset();
  progressListeners.clear();
});

const fill = async () => {
  await userEvent.type(screen.getByLabelText("아이디"), "junho_p");
  await userEvent.type(screen.getByLabelText("비밀번호 또는 애플리케이션 비밀번호"), "app-pw");
};

const next = () => userEvent.click(screen.getByRole("button", { name: "다음" }));
const connect = () => userEvent.click(screen.getByRole("button", { name: "연결" }));

describe("AddAccountDialog", () => {
  it("입력이 비어 있으면 다음으로 갈 수 없다", () => {
    render(<AddAccountDialog onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();
  });

  it("표시 이름 기본값은 메일 주소 앞부분이고 색은 계정 수에 따라 정해진다", async () => {
    render(<AddAccountDialog onClose={vi.fn()} onAdded={vi.fn()} accounts={FAKE_ACCOUNTS} />);
    await fill();
    await next();
    expect(screen.getByLabelText("표시 이름")).toHaveValue("junho_p");
    expect(screen.getByRole("button", { name: "보라" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^파랑/ })).toHaveAccessibleName(
      "파랑 (다른 계정이 사용 중)",
    );
  });

  it("고른 이름과 색을 add_account에 넘기고 추가된 계정을 알린다", async () => {
    addAccount.mockResolvedValue(FAKE_ACCOUNTS[2]);
    const onAdded = vi.fn();
    render(<AddAccountDialog onClose={vi.fn()} onAdded={onAdded} accounts={FAKE_ACCOUNTS} />);
    await fill();
    await next();
    await userEvent.clear(screen.getByLabelText("표시 이름"));
    await userEvent.type(screen.getByLabelText("표시 이름"), "내 네이버");
    await userEvent.click(screen.getByRole("button", { name: "청록" }));
    await connect();
    expect(addAccount).toHaveBeenCalledWith({
      provider: "naver",
      email: "junho_p@naver.com",
      password: "app-pw",
      name: "내 네이버",
      colorIndex: 6,
    });
    expect(onAdded).toHaveBeenCalledWith(FAKE_ACCOUNTS[2]);
  });

  it("로그인에 실패하면 입력 화면으로 돌아가 안내를 보여주고 다시 시도할 수 있다", async () => {
    addAccount.mockImplementation(() =>
      Promise.reject({ kind: "auth", message: "IMAP 사용이 켜져 있는지 확인해 주세요." }),
    );
    const onAdded = vi.fn();
    render(<AddAccountDialog onClose={vi.fn()} onAdded={onAdded} />);
    await fill();
    await next();
    await connect();
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
    await next();
    await connect();
    expect(addAccount).toHaveBeenCalledWith({
      provider: "gmail",
      email: "junho.park@gmail.com",
      password: "abcdabcdabcdabcd",
      name: "junho.park",
      colorIndex: 1,
    });
  });
});

describe("AddAccountDialog 동기화 진행", () => {
  const reachSync = async (onClose = vi.fn()) => {
    addAccount.mockResolvedValue(FAKE_ACCOUNTS[2]);
    render(<AddAccountDialog onClose={onClose} onAdded={vi.fn()} />);
    await fill();
    await next();
    await connect();
    return onClose;
  };

  it("진행 알림이 오기 전에는 목록을 확인하는 중이라고 보여준다", async () => {
    await reachSync();
    expect(await screen.findByText("메일 목록을 확인하는 중…")).toBeInTheDocument();
    expect(screen.getByText(/백그라운드에서 계속돼요/)).toBeInTheDocument();
  });

  it("add_account가 끝나기 전에 온 알림도 놓치지 않는다", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    addAccount.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<AddAccountDialog onClose={vi.fn()} onAdded={vi.fn()} />);
    await fill();
    await next();
    await connect();
    emit({ done: 0, total: 1880 });
    await act(async () => resolve(FAKE_ACCOUNTS[2]));
    expect(await screen.findByText("1,880통", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("알림에 따라 받은 수와 진행률이 바뀌고, 다른 계정의 알림은 무시한다", async () => {
    await reachSync();
    emit({ done: 0, total: 200 });
    emit({ done: 50, total: 200 });
    emit({ accountId: "other", done: 190, total: 200 });
    expect(await screen.findByText("50")).toBeInTheDocument();
    expect(screen.getByText("/ 200통")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("메일을 가져오고 있어요");
  });

  it("다 받으면 완료로 바뀌고, 받을 게 없어도 완료로 보인다", async () => {
    await reachSync();
    emit({ done: 200, total: 200 });
    expect(await screen.findByRole("heading", { level: 2 })).toHaveTextContent(
      "메일을 모두 가져왔어요",
    );
    expect(screen.getByRole("button", { name: "메일함 열기" })).toBeInTheDocument();
  });

  it("받을 메일이 더 없으면 그렇게 알려준다", async () => {
    await reachSync();
    emit({ done: 0, total: 0 });
    expect(await screen.findByText("더 가져올 메일이 없어요.")).toBeInTheDocument();
  });

  it("실패하면 오류와 이미 받은 메일이 남는다는 안내를 보여준다", async () => {
    await reachSync();
    emit({ done: 40, total: 200, error: "서버 연결이 끊겼어요." });
    expect(await screen.findByRole("alert")).toHaveTextContent("서버 연결이 끊겼어요.");
    expect(screen.getByRole("alert")).toHaveTextContent("이미 받은 메일은 그대로");
    expect(screen.getByRole("button", { name: "메일함 열기" })).toBeInTheDocument();
  });

  it("창을 닫아도 구독만 풀릴 뿐 동기화를 멈추는 호출은 없다", async () => {
    const onClose = await reachSync();
    await userEvent.click(await screen.findByRole("button", { name: "백그라운드로 계속 받기" }));
    expect(onClose).toHaveBeenCalled();
    expect(addAccount).toHaveBeenCalledTimes(1);
  });
});
