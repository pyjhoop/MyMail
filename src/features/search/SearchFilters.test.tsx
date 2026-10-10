import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Account } from "../../lib/ipc";
import { OlderNote, SearchFilters } from "./SearchFilters";

const NOW = new Date(2026, 9, 10, 15, 30);
const accounts = [
  { id: "a1", name: "개인 Gmail", colorIndex: 1 },
  { id: "a2", name: "네이버", colorIndex: 3 },
] as Account[];

function setup(query: string, scope: string | null = null) {
  const onQueryChange = vi.fn();
  const onRequestSender = vi.fn();
  const onScopeChange = vi.fn();
  render(
    <SearchFilters
      query={query}
      onQueryChange={onQueryChange}
      onRequestSender={onRequestSender}
      accounts={accounts}
      scopeAccountId={scope}
      onScopeChange={onScopeChange}
      now={NOW}
    />,
  );
  return { onQueryChange, onRequestSender, onScopeChange };
}

describe("검색 필터 칩", () => {
  it("첨부 있음을 누르면 has:첨부를 넣고, 켜져 있으면 뺀다", () => {
    const a = setup("항공권");
    fireEvent.click(screen.getByRole("button", { name: "첨부 있음" }));
    expect(a.onQueryChange).toHaveBeenCalledWith("항공권 has:첨부");
  });

  it("켜진 첨부 있음은 aria-pressed이고 다시 누르면 지운다", () => {
    const a = setup("항공권 has:첨부");
    const chip = screen.getByRole("button", { name: "첨부 있음" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(chip);
    expect(a.onQueryChange).toHaveBeenCalledWith("항공권");
  });

  it("기간을 고르면 오늘 기준 after: 날짜를 넣는다", () => {
    const a = setup("항공권");
    fireEvent.click(screen.getByRole("button", { name: "기간" }));
    fireEvent.click(screen.getByRole("option", { name: "최근 3개월" }));
    expect(a.onQueryChange).toHaveBeenCalledWith("항공권 after:2026-07-10");
  });

  it("기간이 걸려 있으면 이름이 보이고 ×로 해제한다", () => {
    const a = setup("항공권 after:2026-07-10");
    expect(screen.getByText("기간: 최근 3개월")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "기간 필터 해제" }));
    expect(a.onQueryChange).toHaveBeenCalledWith("항공권");
  });

  it("보낸사람 칩은 입력창에서 이어 쓰게 하고, 걸린 보낸사람은 ×로 뺀다", () => {
    const a = setup("항공권");
    fireEvent.click(screen.getByRole("button", { name: "보낸사람" }));
    expect(a.onRequestSender).toHaveBeenCalled();
  });

  it("걸린 보낸사람을 해제한다", () => {
    const a = setup("항공권 from:doyun@gmail.com");
    expect(screen.getByText("보낸사람: doyun@gmail.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "보낸사람 doyun@gmail.com 필터 해제" }));
    expect(a.onQueryChange).toHaveBeenCalledWith("항공권");
  });

  it("계정을 고르면 범위가 바뀐다", () => {
    const a = setup("항공권");
    fireEvent.click(screen.getByRole("button", { name: "계정: 전체" }));
    fireEvent.click(screen.getByRole("option", { name: "네이버" }));
    expect(a.onScopeChange).toHaveBeenCalledWith("a2");
  });

  it("고른 계정 이름이 칩에 보이고 전체로 되돌릴 수 있다", () => {
    const a = setup("항공권", "a1");
    fireEvent.click(screen.getByRole("button", { name: "계정: 개인 Gmail" }));
    fireEvent.click(screen.getByRole("option", { name: "전체" }));
    expect(a.onScopeChange).toHaveBeenCalledWith(null);
  });
});

describe("기간 밖 결과 안내", () => {
  it("기간 필터가 있고 오래된 결과가 있으면 안내하고 해제 링크를 준다", () => {
    const onQueryChange = vi.fn();
    render(
      <OlderNote
        query="항공권 after:2026-07-10"
        olderCount={2}
        onQueryChange={onQueryChange}
        now={NOW}
      />,
    );
    expect(screen.getByText(/3개월보다 오래된 결과 2개 더 있음/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "기간 필터 해제" }));
    expect(onQueryChange).toHaveBeenCalledWith("항공권");
  });

  it("오래된 결과가 없거나 기간 필터가 없으면 아무것도 그리지 않는다", () => {
    const { container, rerender } = render(
      <OlderNote query="항공권 after:2026-07-10" olderCount={0} onQueryChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<OlderNote query="항공권" olderCount={5} onQueryChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
