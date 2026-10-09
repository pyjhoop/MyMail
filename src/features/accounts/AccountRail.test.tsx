import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FAKE_ACCOUNTS } from "../../lib/fakeData";
import { AccountRail } from "./AccountRail";

const setup = (selected = "all") => {
  const onSelect = vi.fn();
  render(
    <AccountRail
      accounts={FAKE_ACCOUNTS}
      selected={selected}
      onSelect={onSelect}
      onAddAccount={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
  return onSelect;
};

describe("AccountRail", () => {
  it("계정 수만큼 아바타를 보여주고 안 읽은 수는 99+로 줄인다", () => {
    setup();
    expect(screen.getAllByRole("button", { name: /Gmail|네이버/ })).toHaveLength(3);
    expect(screen.getAllByText("99+").length).toBeGreaterThan(0);
  });

  it("계정을 누르면 선택 콜백을 부른다", async () => {
    const onSelect = setup();
    await userEvent.click(screen.getByRole("button", { name: /네이버/ }));
    expect(onSelect).toHaveBeenCalledWith("a3");
  });

  it("선택된 계정을 표시한다", () => {
    setup("a1");
    expect(screen.getByRole("button", { name: /\(선택됨\)/ })).toBeInTheDocument();
  });
});
