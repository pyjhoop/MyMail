import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("앱 이름을 렌더링한다", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "MyMail" })).toBeInTheDocument();
  });
});
