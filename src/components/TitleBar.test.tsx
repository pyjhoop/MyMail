import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TitleBar } from "./TitleBar";

describe("TitleBar", () => {
  it("동기화 중이면 진행률 막대를 보여준다", () => {
    render(
      <TitleBar syncLabel="메일 가져오는 중 2/8" syncProgress={0.25} onOpenSettings={vi.fn()} />,
    );
    expect(screen.getByText("메일 가져오는 중 2/8")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });

  it("동기화 중이 아니면 막대를 숨긴다", () => {
    render(<TitleBar syncLabel="방금 동기화됨" onOpenSettings={vi.fn()} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
