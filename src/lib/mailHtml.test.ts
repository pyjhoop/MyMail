import { describe, expect, it } from "vitest";
import { buildMailDocument, isOpenableLink, prepareMailHtml } from "./mailHtml";

const colors = { background: "#fff", text: "#000", link: "#00f", fontFamily: "sans-serif" };

describe("prepareMailHtml", () => {
  it("스크립트·이벤트 핸들러·javascript: 링크·폼·프레임을 제거한다", () => {
    const { html } = prepareMailHtml(
      `<p onclick="x()">본문</p><script>alert(1)</script>
       <a href="javascript:alert(1)">링크</a><iframe src="https://evil.test"></iframe>
       <form action="https://evil.test"><input name="a"></form><object data="x"></object>`,
      true,
    );
    expect(html).toContain("본문");
    expect(html).not.toMatch(/script|onclick|javascript:|<iframe|<form|<input|<object/i);
  });

  it("맨 앞의 style 태그를 보존한다", () => {
    const { html } = prepareMailHtml("<style>p { color: red }</style><p>본문</p>", true);
    expect(html).toContain("<style>");
  });

  it("외부 이미지는 기본적으로 주소를 떼고 개수를 센다", () => {
    const raw = `<img src="https://t.test/a.png" alt="a"><img src="//t.test/b.png">
      <table background="http://t.test/bg.png"><tr><td style="background:url(https://t.test/c.png)">x</td></tr></table>`;
    const blocked = prepareMailHtml(raw, false);
    expect(blocked.externalImages).toBe(4);
    expect(blocked.html).not.toContain("t.test");
    expect(blocked.html).toContain('alt="a"');
  });

  it("이미지 표시를 켜면 주소를 그대로 둔다", () => {
    const shown = prepareMailHtml(`<img src="https://t.test/a.png">`, true);
    expect(shown.html).toContain("https://t.test/a.png");
  });

  it("data: 이미지(cid에서 바뀐 인라인 이미지)는 외부 이미지로 세지 않고 항상 보인다", () => {
    const { html, externalImages } = prepareMailHtml(
      `<img src="data:image/png;base64,SGVsbG8=">`,
      false,
    );
    expect(externalImages).toBe(0);
    expect(html).toContain("data:image/png;base64,SGVsbG8=");
  });

  it("srcset은 차단한다", () => {
    const { html } = prepareMailHtml(
      `<img src="data:image/png;base64,AA==" srcset="https://t.test/a.png 2x">`,
      true,
    );
    expect(html).not.toContain("srcset");
  });
});

describe("buildMailDocument", () => {
  it("외부 이미지는 CSP로도 막고, 표시를 켜면 이미지만 허용한다", () => {
    const off = buildMailDocument("<p>x</p>", { showImages: false, colors });
    expect(off).toContain("default-src 'none'");
    expect(off).toContain("img-src data:;");
    const on = buildMailDocument("<p>x</p>", { showImages: true, colors });
    expect(on).toContain("img-src data: https: http:;");
    expect(on).not.toContain("script-src");
  });
});

describe("isOpenableLink", () => {
  it("http(s)와 mailto만 연다", () => {
    expect(isOpenableLink("https://a.test")).toBe(true);
    expect(isOpenableLink(" mailto:a@b.com")).toBe(true);
    expect(isOpenableLink("javascript:alert(1)")).toBe(false);
    expect(isOpenableLink("file:///C:/x")).toBe(false);
    expect(isOpenableLink("#top")).toBe(false);
  });
});
