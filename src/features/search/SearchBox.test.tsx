import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_ACCOUNTS } from "../../test/fixtures";
import { SearchBox } from "./SearchBox";

function Harness({ onSubmit = vi.fn() }: { onSubmit?: (v: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <>
      <SearchBox
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        scopeLabel="모든 계정"
        accountId={null}
        accounts={FAKE_ACCOUNTS}
      />
      <button type="button">바깥</button>
    </>
  );
}

const box = () => screen.getByRole("searchbox", { name: "메일 검색" });

beforeEach(() => {
  localStorage.clear();
});

describe("검색창 추천", () => {
  it("포커스하면 보낸사람 추천과 검색어 팁이 뜨고 범위가 보인다", async () => {
    render(<Harness />);
    expect(screen.getByText("모든 계정")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.focus(box());
    expect(await screen.findByRole("option", { name: /김도윤/ })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "검색 추천" })).toBeInTheDocument();
    expect(screen.getByText("has:첨부")).toBeInTheDocument();
    expect(screen.getByText("Tab 보낸사람 필터로")).toBeInTheDocument();
  });

  it("Enter로 검색하면 최근 검색에 저장되고 다음에 다시 보인다", async () => {
    const onSubmit = vi.fn();
    const first = render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(box(), { target: { value: "항공권" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("항공권");
    expect(localStorage.getItem("mymail.recentSearches")).toBe('["항공권"]');
    first.unmount();

    render(<Harness />);
    fireEvent.focus(box());
    expect(await screen.findByRole("option", { name: /항공권/ })).toBeInTheDocument();
    expect(screen.getByText("최근 검색")).toBeInTheDocument();
  });

  it("방향키로 항목을 고르고 Enter로 검색한다 (보낸사람은 from: 조건이 된다)", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.focus(box());
    await screen.findByRole("option", { name: /김도윤/ });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box()).toHaveAttribute("aria-activedescendant");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("from:doyun.kim@gmail.com");
  });

  it("Tab은 검색하지 않고 보낸사람 필터로 바꿔 이어 쓰게 한다", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(box(), { target: { value: "명세서 김" } });
    await screen.findByRole("option", { name: /김도윤/ });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box()).toHaveValue("명세서 from:doyun.kim@gmail.com ");
  });

  it("Esc는 추천만 닫고, 한 번 더 누르면 입력을 지운다", async () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "견적" } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box()).toHaveValue("견적");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box()).toHaveValue("");
  });

  it("최근 검색을 개별로 지울 수 있다", async () => {
    localStorage.setItem("mymail.recentSearches", JSON.stringify(["항공권", "명세서"]));
    render(<Harness />);
    fireEvent.focus(box());
    fireEvent.click(await screen.findByRole("button", { name: "최근 검색에서 삭제: 항공권" }));
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /항공권/ })).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem("mymail.recentSearches")).toBe('["명세서"]');
  });

  it("값이 있으면 지우기 버튼이 보이고 누르면 비운다", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "검색 지우기" })).not.toBeInTheDocument();
    fireEvent.change(box(), { target: { value: "견적" } });
    fireEvent.click(screen.getByRole("button", { name: "검색 지우기" }));
    expect(box()).toHaveValue("");
  });

  it("검색어 팁을 누르면 입력에 덧붙는다", async () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "견적" } });
    fireEvent.click(await screen.findByRole("button", { name: "is:안읽음" }));
    expect(box()).toHaveValue("견적 is:안읽음");
  });
});
