import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Account } from "../../lib/ipc";
import { SearchScope } from "./SearchScope";

const accounts = [
  { id: "a1", name: "개인 Gmail", colorIndex: 1, unread: 12 },
  { id: "a2", name: "네이버", colorIndex: 3, unread: 99 },
] as Account[];

describe("SearchScope", () => {
  it("모든 계정과 계정별 결과 수, 제외 안내를 보여 준다", () => {
    render(
      <SearchScope
        accounts={accounts}
        counts={[
          { accountId: "a1", count: 3, capped: false },
          { accountId: "a2", count: 1000, capped: true },
        ]}
        selectedId={null}
        collapsed={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("검색 범위")).toBeInTheDocument();
    expect(screen.getByText("계정 2개 · 안 읽음 111")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /모든 계정/ })).toHaveTextContent("1,003+");
    expect(screen.getByRole("button", { name: /개인 Gmail/ })).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: /네이버/ })).toHaveTextContent("1,000+");
    expect(screen.getByRole("button", { name: /모든 계정/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(
      screen.getByText("받은편지함·보낸편지함·보관함을 함께 찾아요. 스팸·휴지통은 제외됩니다."),
    ).toBeInTheDocument();
  });

  it("건수를 아직 못 받았으면 숫자 자리를 비운다", () => {
    render(
      <SearchScope
        accounts={accounts}
        counts={undefined}
        selectedId="a1"
        collapsed={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /모든 계정/ })).toHaveTextContent(/^모든 계정$/);
  });

  it("범위를 고르면 계정 id(모든 계정은 null)로 알린다", () => {
    const onSelect = vi.fn();
    render(
      <SearchScope
        accounts={accounts}
        counts={[]}
        selectedId={null}
        collapsed={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /네이버/ }));
    expect(onSelect).toHaveBeenLastCalledWith("a2");
    fireEvent.click(screen.getByRole("button", { name: /모든 계정/ }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});
