import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyFolder, type FolderKind } from "../../lib/ipc";
import { EmptyFolderBar } from "./EmptyFolderBar";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return { ...actual, emptyFolder: vi.fn(() => Promise.resolve()) };
});

function setup(kind: FolderKind, count = 3) {
  const onDone = vi.fn();
  const onError = vi.fn();
  render(
    <EmptyFolderBar
      accountId="a1"
      folderId={`a1-${kind}`}
      kind={kind}
      count={count}
      onDone={onDone}
      onError={onError}
    />,
  );
  return { onDone, onError };
}

describe("휴지통·스팸함 비우기", () => {
  beforeEach(() => {
    vi.mocked(emptyFolder).mockReset();
    vi.mocked(emptyFolder).mockResolvedValue(undefined);
  });

  it("휴지통과 스팸함에서만 버튼이 보인다", () => {
    for (const kind of ["inbox", "sent", "drafts", "archive", "label", "folder"] as const) {
      const { container } = render(
        <EmptyFolderBar
          accountId="a1"
          folderId="x"
          kind={kind}
          count={3}
          onDone={vi.fn()}
          onError={vi.fn()}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    }
    setup("trash");
    expect(screen.getByRole("button", { name: "휴지통 비우기" })).toBeInTheDocument();
  });

  it("스팸함에서는 '스팸함 비우기'로 보인다", () => {
    setup("spam");
    expect(screen.getByRole("button", { name: "스팸함 비우기" })).toBeInTheDocument();
  });

  it("메일이 0통이면 비활성이다", () => {
    setup("trash", 0);
    expect(screen.getByRole("button", { name: "휴지통 비우기" })).toBeDisabled();
  });

  it("확인을 취소하면 emptyFolder를 부르지 않는다", () => {
    setup("trash");
    fireEvent.click(screen.getByRole("button", { name: "휴지통 비우기" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("이 폴더의 모든 메일");
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(emptyFolder).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("확인하면 emptyFolder를 부르고 끝나면 목록을 다시 읽게 한다", async () => {
    const { onDone, onError } = setup("spam");
    fireEvent.click(screen.getByRole("button", { name: "스팸함 비우기" }));
    fireEvent.click(screen.getByRole("button", { name: "완전히 삭제" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(emptyFolder).toHaveBeenCalledWith("a1", "a1-spam");
    expect(onError).not.toHaveBeenCalled();
  });

  it("실패하면 안내를 알리고 그래도 목록을 다시 읽는다", async () => {
    vi.mocked(emptyFolder).mockRejectedValue({ kind: "unknown", message: "비울 수 없어요" });
    const { onDone, onError } = setup("trash");
    fireEvent.click(screen.getByRole("button", { name: "휴지통 비우기" }));
    fireEvent.click(screen.getByRole("button", { name: "완전히 삭제" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onError).toHaveBeenCalledWith("비울 수 없어요");
  });
});
