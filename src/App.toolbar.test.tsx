import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import {
  archiveMail,
  deleteMail,
  getMail,
  listFolders,
  listMails,
  moveMail,
  setRead,
  setStarred,
  type Folder,
  type MailDetail,
  type MailSummary,
} from "./lib/ipc";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    archiveMail: vi.fn(),
    deleteMail: vi.fn(),
    moveMail: vi.fn(),
    setRead: vi.fn(),
    setStarred: vi.fn(),
    getMail: vi.fn(),
    listFolders: vi.fn(),
    listMails: vi.fn(),
  };
});

// jsdom은 크기가 0이라 가상화 목록이 행을 그리지 않는다. 모든 행을 그리는 대역으로 바꾼다.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 84,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 84 })),
  }),
}));

const folder = (id: string, name: string, kind: Folder["kind"]): Folder => ({
  id,
  accountId: "a1",
  name,
  kind,
  unread: 0,
});
const FOLDERS: Folder[] = [
  folder("a1-inbox", "받은편지함", "inbox"),
  folder("a1-spam", "스팸", "spam"),
  folder("a1-all", "전체보관함", "archive"),
  folder("a1-proj", "프로젝트", "folder"),
];

const mail = (id: string, subject: string, folderId = "a1-inbox"): MailSummary => ({
  id,
  accountId: "a1",
  folderId,
  sender: "김도윤",
  senderEmail: "doyun@example.com",
  subject,
  preview: "미리보기",
  time: "오전 9:00",
  unread: false,
  starred: false,
  hasAttachment: false,
  labels: [],
});

/** 폴더별 메일을 기억하는 백엔드 대역. 지우기·보관·이동이 성공하면 목록에서 빠진다. */
let boxes: Record<string, MailSummary[]>;
const all = () => Object.values(boxes).flat();
function removeFromBoxes(id: string) {
  for (const key of Object.keys(boxes)) boxes[key] = boxes[key].filter((m) => m.id !== id);
}

function backend() {
  boxes = {
    "a1-inbox": [mail("m1", "첫째 메일"), mail("m2", "둘째 메일"), mail("m3", "셋째 메일")],
    "a1-all": [mail("m9", "보관된 메일", "a1-all")],
    "a1-spam": [mail("m8", "스팸 메일", "a1-spam")],
  };
  vi.mocked(listFolders).mockImplementation(async (accountId) =>
    accountId === "a1" ? FOLDERS : [],
  );
  vi.mocked(listMails).mockImplementation(async (_account, folderId) => ({
    mails: [...(boxes[folderId] ?? [])],
  }));
  vi.mocked(getMail).mockImplementation(async (id) => {
    const m = all().find((x) => x.id === id);
    return m
      ? ({
          ...m,
          to: "나",
          body: [`${m.subject} 본문`],
          attachments: [],
          earlier: [],
          fullTime: "오늘",
        } satisfies MailDetail)
      : null;
  });
  vi.mocked(deleteMail).mockImplementation(async (id) => removeFromBoxes(id));
  vi.mocked(archiveMail).mockImplementation(async (id) => removeFromBoxes(id));
  vi.mocked(moveMail).mockImplementation(async (id) => removeFromBoxes(id));
  vi.mocked(setRead).mockImplementation(async (id, read) => {
    for (const list of Object.values(boxes)) {
      list.forEach((m, i) => {
        if (m.id === id) list[i] = { ...m, unread: !read };
      });
    }
  });
  vi.mocked(setStarred).mockResolvedValue(undefined);
}

const reader = () => screen.getByRole("main");
const toolbarButton = (name: string) => within(reader()).getByRole("button", { name });
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

/** 개인 Gmail 계정의 받은편지함에서 메일 하나를 연다. */
async function open(subject: string) {
  fireEvent.click(await screen.findByRole("button", { name: /^개인 Gmail/ }));
  fireEvent.click(await screen.findByText(subject));
  await heading(subject);
}

async function pickFromMenu(...names: string[]) {
  fireEvent.click(toolbarButton("더보기"));
  for (const name of names) {
    fireEvent.click(await screen.findByRole("menuitem", { name }));
  }
}

describe("본문 도구 모음: 삭제", () => {
  beforeEach(backend);

  it("삭제 버튼이 deleteMail을 부르고 다음 메일을 연다", async () => {
    render(<App />);
    await open("둘째 메일");

    fireEvent.click(toolbarButton("삭제"));

    await waitFor(() => expect(deleteMail).toHaveBeenCalledWith("m2"));
    expect(await heading("셋째 메일")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("마지막 메일을 지우면 이전 메일을 연다", async () => {
    render(<App />);
    await open("셋째 메일");

    fireEvent.click(toolbarButton("삭제"));

    expect(await heading("둘째 메일")).toBeInTheDocument();
    expect(deleteMail).toHaveBeenCalledWith("m3");
  });

  it("목록의 마지막 한 통을 지우면 빈 본문이 된다", async () => {
    boxes["a1-inbox"] = [mail("m1", "첫째 메일")];
    render(<App />);
    await open("첫째 메일");

    fireEvent.click(toolbarButton("삭제"));

    await waitFor(() => expect(deleteMail).toHaveBeenCalledWith("m1"));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { level: 1, name: "첫째 메일" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("메일을 열기 전에는 보관·삭제·더보기가 막혀 있다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^개인 Gmail/ }));
    await screen.findByText("첫째 메일");
    expect(toolbarButton("보관")).toBeDisabled();
    expect(toolbarButton("삭제")).toBeDisabled();
    expect(toolbarButton("더보기")).toBeDisabled();
  });
});

describe("본문 도구 모음: 보관", () => {
  beforeEach(backend);
  afterEach(() => vi.useRealTimers());

  it("보관하면 목록에서 바로 치우고 다음 메일을 열며 실행 취소 토스트를 띄운다", async () => {
    render(<App />);
    await open("둘째 메일");

    fireEvent.click(toolbarButton("보관"));

    expect(await heading("셋째 메일")).toBeInTheDocument();
    expect(screen.getByText("보관했어요")).toBeInTheDocument();
    expect(screen.queryByText("둘째 메일")).not.toBeInTheDocument();
    // 실행 취소할 수 있는 동안에는 서버로 보내지 않는다
    expect(archiveMail).not.toHaveBeenCalled();
  });

  it("실행 취소를 누르면 메일이 돌아오고 서버로 보내지 않는다", async () => {
    render(<App />);
    await open("둘째 메일");
    fireEvent.click(toolbarButton("보관"));
    await heading("셋째 메일");

    fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));

    expect(await heading("둘째 메일")).toBeInTheDocument();
    expect(screen.getAllByText("둘째 메일").length).toBeGreaterThan(0);
    expect(screen.queryByText("보관했어요")).not.toBeInTheDocument();
    expect(archiveMail).not.toHaveBeenCalled();
  });

  it("실행 취소 시간이 지나면 archiveMail로 보낸다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await open("둘째 메일");
    fireEvent.click(toolbarButton("보관"));
    expect(archiveMail).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });

    expect(archiveMail).toHaveBeenCalledWith("m2");
    expect(screen.queryByText("보관했어요")).not.toBeInTheDocument();
  });

  it("다른 메일을 보관하면 앞의 보관은 바로 서버로 보낸다", async () => {
    render(<App />);
    await open("첫째 메일");
    fireEvent.click(toolbarButton("보관"));
    await heading("둘째 메일");
    expect(archiveMail).not.toHaveBeenCalled();

    fireEvent.click(toolbarButton("보관"));

    await waitFor(() => expect(archiveMail).toHaveBeenCalledWith("m1"));
    expect(archiveMail).toHaveBeenCalledTimes(1);
  });

  it("e 키로도 보관한다", async () => {
    render(<App />);
    await open("첫째 메일");

    fireEvent.keyDown(document.body, { key: "e" });

    expect(await screen.findByText("보관했어요")).toBeInTheDocument();
    expect(await heading("둘째 메일")).toBeInTheDocument();
  });

  it("서버가 거절하면 메일이 목록에 돌아오고 이유를 알린다", async () => {
    vi.mocked(archiveMail).mockRejectedValueOnce({
      kind: "unknown",
      message: "이 계정에서는 보관 폴더를 만들 수 없어요.",
    });
    render(<App />);
    await open("첫째 메일");
    fireEvent.click(toolbarButton("보관"));
    await heading("둘째 메일");
    fireEvent.click(toolbarButton("보관"));

    expect(await screen.findByRole("alert")).toHaveTextContent("메일을 보관하지 못했어요");
    expect(screen.getAllByText("첫째 메일").length).toBeGreaterThan(0);
  });

  it("이미 보관된 메일은 보관 버튼이 막히고 e도 듣지 않는다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^개인 Gmail/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^전체보관함/ }));
    fireEvent.click(await screen.findByText("보관된 메일"));
    await heading("보관된 메일");

    await waitFor(() => expect(toolbarButton("보관")).toBeDisabled());
    expect(toolbarButton("보관")).toHaveAttribute("title", "이미 보관된 메일이에요");
    fireEvent.keyDown(document.body, { key: "e" });
    expect(screen.queryByText("보관했어요")).not.toBeInTheDocument();
  });
});

describe("본문 도구 모음: 더보기", () => {
  beforeEach(backend);

  it("읽지 않음으로 표시하면 setRead(false)를 부르고 곧바로 다시 읽음 처리하지 않는다", async () => {
    render(<App />);
    await open("둘째 메일");
    expect(setRead).not.toHaveBeenCalled();

    await pickFromMenu("읽지 않음으로 표시");

    expect(setRead).toHaveBeenCalledTimes(1);
    expect(setRead).toHaveBeenCalledWith("m2", false);
    expect(screen.getByLabelText("안 읽음")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1300));
    expect(setRead).toHaveBeenCalledTimes(1);
    // 같은 메일을 다시 골라야 읽음 처리된다
    fireEvent.click(
      within(screen.getByRole("region", { name: "메일 목록" })).getByText("둘째 메일"),
    );
    await waitFor(() => expect(setRead).toHaveBeenLastCalledWith("m2", true));
  });

  it("안 읽은 메일이면 메뉴가 읽음으로 표시를 보여 준다", async () => {
    boxes["a1-inbox"][1] = { ...boxes["a1-inbox"][1], unread: true };
    render(<App />);
    await open("둘째 메일");
    // 선택하면 읽음 처리돼 항목이 바뀐다
    await waitFor(() => expect(setRead).toHaveBeenCalledWith("m2", true));
    await pickFromMenu("읽지 않음으로 표시");
    expect(setRead).toHaveBeenLastCalledWith("m2", false);
  });

  it("별표를 추가하면 setStarred를 부르고 헤더에 별표가 보인다", async () => {
    render(<App />);
    await open("둘째 메일");

    await pickFromMenu("별표 추가");

    expect(setStarred).toHaveBeenCalledWith("m2", true);
    expect(await screen.findByLabelText("별표 표시됨")).toBeInTheDocument();
    fireEvent.click(toolbarButton("더보기"));
    expect(await screen.findByRole("menuitem", { name: "별표 해제" })).toBeInTheDocument();
  });

  it("폴더로 이동은 이동 가능한 폴더만 보여 주고 moveMail을 부른다", async () => {
    render(<App />);
    await open("둘째 메일");

    fireEvent.click(toolbarButton("더보기"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /폴더로 이동/ }));
    // 지금 폴더(받은편지함)는 빠진다
    expect(screen.queryByRole("menuitem", { name: "받은편지함" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("menuitem", { name: "프로젝트" }));

    await waitFor(() => expect(moveMail).toHaveBeenCalledWith("m2", "a1-proj"));
    expect(await heading("셋째 메일")).toBeInTheDocument();
    expect(await screen.findByText(/프로젝트.*옮겼어요/)).toBeInTheDocument();
  });

  it("스팸으로 신고하면 스팸함으로 옮긴다", async () => {
    render(<App />);
    await open("둘째 메일");

    await pickFromMenu("스팸으로 신고");

    await waitFor(() => expect(moveMail).toHaveBeenCalledWith("m2", "a1-spam"));
    expect(await screen.findByText("스팸으로 신고했어요")).toBeInTheDocument();
  });

  it("스팸함의 메일은 스팸 아님으로 받은편지함에 되돌린다", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^개인 Gmail/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^스팸/ }));
    fireEvent.click(await screen.findByText("스팸 메일"));
    await heading("스팸 메일");
    await waitFor(() => expect(toolbarButton("더보기")).toBeEnabled());

    await pickFromMenu("스팸 아님");

    await waitFor(() => expect(moveMail).toHaveBeenCalledWith("m8", "a1-inbox"));
  });

  it("이동에 실패하면 안내하고 메일은 그대로다", async () => {
    vi.mocked(moveMail).mockRejectedValueOnce({
      kind: "unknown",
      message: "폴더를 찾을 수 없어요",
    });
    render(<App />);
    await open("둘째 메일");

    await pickFromMenu("스팸으로 신고");

    expect(await screen.findByRole("alert")).toHaveTextContent("메일을 옮기지 못했어요");
    expect(screen.getAllByText("둘째 메일").length).toBeGreaterThan(0);
  });
});
