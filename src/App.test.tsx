import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("4단 레이아웃의 영역을 렌더링한다", async () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "계정" })).toBeInTheDocument();
    expect(screen.getByLabelText("폴더")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "메일 목록" })).toBeInTheDocument();
    expect(screen.getByText("메일을 선택하세요")).toBeInTheDocument();
    expect(await screen.findByLabelText("개인 Gmail · junho.park@gmail.com")).toBeInTheDocument();
  });

  it("처음에는 통합 받은편지함을 보여준다", async () => {
    render(<App />);
    expect(await screen.findByText("계정별 받은편지함")).toBeInTheDocument();
  });
});
