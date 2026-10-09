import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HtmlBody } from "./HtmlBody";

describe("HtmlBody", () => {
  it("스크립트 없는 샌드박스 iframe에 정제한 본문을 넣는다", () => {
    render(<HtmlBody html={`<p>안녕</p><script>alert(1)</script>`} />);
    const frame = screen.getByTitle("메일 본문");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    const doc = frame.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("안녕");
    expect(doc).not.toContain("alert(1)");
    expect(doc).toContain("Content-Security-Policy");
  });

  it("외부 이미지가 있으면 안내를 보이고, 버튼을 누르면 허용한다", async () => {
    render(<HtmlBody html={`<img src="https://t.test/a.png">`} />);
    expect(screen.getByRole("status")).toHaveTextContent("외부 이미지를 차단했어요");
    expect(screen.getByTitle("메일 본문").getAttribute("srcdoc")).not.toContain("t.test");

    await userEvent.click(screen.getByRole("button", { name: "이미지 표시" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTitle("메일 본문").getAttribute("srcdoc")).toContain("https://t.test/a.png");
  });

  it("외부 이미지가 없으면 안내를 보이지 않는다", () => {
    render(<HtmlBody html={`<p>글만</p>`} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
