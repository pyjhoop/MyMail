import { describe, expect, it } from "vitest";
import { Highlight } from "./Highlight";
import { splitByTerms } from "./splitByTerms";
import {
  highlightTerms,
  isTooShortToSearch,
  isValidDate,
  parseSearchQuery,
  splitOperators,
} from "./query";
import { render } from "@testing-library/react";

describe("검색 연산자 해석", () => {
  it("연산자와 일반 검색어를 나눈다", () => {
    const q = parseSearchQuery(
      "항공권 from:한결카드 to:me@x.com has:첨부 is:안읽음 is:별표 after:2026-09-01",
    );
    expect(q.terms).toEqual(["항공권"]);
    expect(q.from).toEqual(["한결카드"]);
    expect(q.to).toEqual(["me@x.com"]);
    expect(q.hasAttachment).toBe(true);
    expect(q.unread).toBe(true);
    expect(q.starred).toBe(true);
    expect(q.after).toBe("2026-09-01");
    expect(parseSearchQuery("is:읽음").unread).toBe(false);
  });

  it("모르는 연산자와 잘못된 값은 일반 검색어로 본다", () => {
    expect(parseSearchQuery("foo:bar has:없음 after:2026-13-40 from:").terms).toEqual([
      "foo:bar",
      "has:없음",
      "after:2026-13-40",
      "from:",
    ]);
    expect(isValidDate("2025-02-29")).toBe(false);
    expect(isValidDate("2024-02-29")).toBe(true);
  });

  it("따옴표로 공백이 든 값과 구절을 묶는다", () => {
    const q = parseSearchQuery('from:"한결 카드" "두 단어"');
    expect(q.from).toEqual(["한결 카드"]);
    expect(q.terms).toEqual(["두 단어"]);
  });

  it("강조할 단어는 일반 검색어뿐이다", () => {
    expect(highlightTerms("견적 from:김도윤 is:별표 - 항공")).toEqual(["견적", "항공"]);
  });

  it("최근 검색에서 연산자를 따로 뗀다", () => {
    expect(splitOperators("명세서 from:한결카드")).toEqual({
      text: "명세서",
      operators: ["from:한결카드"],
    });
  });

  it("한 글자는 자동으로 검색하지 않는다", () => {
    expect(isTooShortToSearch("김")).toBe(true);
    expect(isTooShortToSearch("김도")).toBe(false);
    expect(isTooShortToSearch("")).toBe(false);
  });
});

describe("검색어 강조", () => {
  it("대소문자를 가리지 않고 겹치는 구간을 합친다", () => {
    expect(splitByTerms("Invoice 견적서 invoice", ["invoice", "inv"])).toEqual([
      { text: "Invoice", hit: true },
      { text: " 견적서 ", hit: false },
      { text: "invoice", hit: true },
    ]);
    expect(splitByTerms("아무 말", ["없는"])).toEqual([{ text: "아무 말", hit: false }]);
    expect(splitByTerms("글", [])).toEqual([{ text: "글", hit: false }]);
  });

  it("메일 내용의 HTML은 해석하지 않고 글자 그대로 보여 준다", () => {
    const { container } = render(
      Highlight({ text: "<img src=x onerror=alert(1)> 견적", terms: ["견적"] }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("<img src=x onerror=alert(1)> 견적");
    expect(container.querySelectorAll("mark")).toHaveLength(1);
  });
});
