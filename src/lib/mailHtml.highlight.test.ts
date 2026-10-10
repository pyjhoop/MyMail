import { describe, expect, it } from "vitest";
import { buildMailDocument, prepareMailHtml } from "./mailHtml";

describe("HTML 본문의 검색어 강조", () => {
  it("글자(텍스트 노드)에서만 검색어를 <mark>로 감싼다", () => {
    const { html } = prepareMailHtml("<p>항공권 예매 끝났어! <b>항공권</b> 확인</p>", true, [
      "항공권",
    ]);
    expect(html.match(/<mark>항공권<\/mark>/g)).toHaveLength(2);
    expect(html).toContain("<b><mark>항공권</mark></b>");
  });

  it("태그 이름·속성·style 안의 글은 건드리지 않는다", () => {
    const { html } = prepareMailHtml(
      '<style>.p { color: red }</style><a href="https://x.test/p" title="p">p</a>',
      true,
      ["p"],
    );
    expect(html).toContain("<style>.p { color: red }</style>");
    expect(html).toContain('href="https://x.test/p"');
    expect(html).toContain('title="p"');
    expect(html).toContain("<mark>p</mark>");
  });

  it("검색어에 HTML이 들어 있어도 해석되지 않는다", () => {
    const { html } = prepareMailHtml("<p>a &lt;img src=x onerror=alert(1)&gt; b</p>", true, [
      "<img",
    ]);
    expect(html).toContain("<mark>&lt;img</mark>");
    expect(html).not.toMatch(/<img/i);
  });

  it("검색어가 없으면 본문을 그대로 둔다", () => {
    expect(prepareMailHtml("<p>항공권</p>", true).html).toBe("<p>항공권</p>");
  });

  it("문서에 강조 색 규칙이 들어간다(다크는 반전값)", () => {
    const colors = { background: "#fff", text: "#000", link: "#00f", fontFamily: "x" };
    const light = buildMailDocument("<p>x</p>", {
      showImages: false,
      colors: { ...colors, highlight: "#fde68a", dark: false },
    });
    expect(light).toContain("mark { background: #fde68a;");
    const dark = buildMailDocument("<p>x</p>", {
      showImages: false,
      colors: { ...colors, highlight: "#6b5410", dark: true },
    });
    expect(dark).toContain("mark { background: #94abef;");
  });
});
