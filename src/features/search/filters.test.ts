import { describe, expect, it } from "vitest";
import {
  activeFilters,
  appendToken,
  formatDate,
  olderThanText,
  operatorOf,
  periodChipText,
  periodLabelFor,
  PERIODS,
  removePeriod,
  removeSender,
  setPeriod,
  splitRaw,
  toggleAttachment,
} from "./filters";
import { hasIncompleteOperator } from "./query";

const NOW = new Date(2026, 9, 10, 15, 30); // 2026-10-10

describe("검색식 고치기", () => {
  it("따옴표 안의 공백은 지키며 원문 그대로 나눈다", () => {
    expect(splitRaw('항공권 from:"한결 카드"  has:첨부')).toEqual([
      "항공권",
      'from:"한결 카드"',
      "has:첨부",
    ]);
  });

  it("올바른 연산자만 알아본다", () => {
    expect(operatorOf("from:김도윤")).toEqual({ key: "from", value: "김도윤" });
    expect(operatorOf('from:"한결 카드"')).toEqual({ key: "from", value: "한결 카드" });
    expect(operatorOf("after:2026-02-30")).toBeNull(); // 없는 날짜
    expect(operatorOf("foo:bar")).toBeNull();
    expect(operatorOf('"from:x"')).toEqual({ key: "from", value: "x" });
    expect(operatorOf('"항공권 예약"')).toBeNull();
  });

  it("첨부 있음을 켜고 끈다", () => {
    expect(toggleAttachment("항공권", true)).toBe("항공권 has:첨부");
    expect(toggleAttachment("항공권 has:첨부", true)).toBe("항공권 has:첨부");
    expect(toggleAttachment("항공권 has:첨부 is:별표", false)).toBe("항공권 is:별표");
    expect(toggleAttachment("has:첨부", false)).toBe("");
  });

  it("보낸사람 하나만 뺀다", () => {
    expect(removeSender("항공권 from:a@x.com from:b@x.com", "a@x.com")).toBe("항공권 from:b@x.com");
    expect(removeSender('항공권 from:"한결 카드"', "한결 카드")).toBe("항공권");
  });

  it("기간은 after: 하나로 바꾸고 해제하면 after·before를 모두 지운다", () => {
    expect(setPeriod("항공권 after:2026-01-01 before:2026-02-01", "2026-07-10")).toBe(
      "항공권 after:2026-07-10",
    );
    expect(removePeriod("항공권 after:2026-07-10 before:2026-08-01 is:별표")).toBe(
      "항공권 is:별표",
    );
    expect(appendToken("a b", "b")).toBe("a b");
  });

  it("기간 선택은 오늘 기준 날짜가 되고 칩에 이름으로 보인다", () => {
    const quarter = PERIODS.find((p) => p.id === "quarter")!;
    expect(formatDate(quarter.start(NOW))).toBe("2026-07-10");
    expect(formatDate(PERIODS.find((p) => p.id === "week")!.start(NOW))).toBe("2026-10-03");
    expect(periodLabelFor("2026-07-10", NOW)).toBe("최근 3개월");
    expect(periodLabelFor("2026-07-11", NOW)).toBeUndefined();
    expect(periodChipText(activeFilters("a after:2026-07-10"), NOW)).toBe("최근 3개월");
    expect(periodChipText(activeFilters("a after:2026-07-11"), NOW)).toBe("2026-07-11 이후");
    expect(periodChipText(activeFilters("a before:2026-07-11"), NOW)).toBe("2026-07-11 이전");
    expect(periodChipText(activeFilters("a after:2026-01-01 before:2026-02-01"), NOW)).toBe(
      "2026-01-01 ~ 2026-02-01",
    );
    expect(periodChipText(activeFilters("a"), NOW)).toBeUndefined();
  });

  it("기간 밖 안내 문구", () => {
    expect(olderThanText("2026-07-10", NOW)).toBe("3개월보다 오래된");
    expect(olderThanText("2026-07-11", NOW)).toBe("2026-07-11 이전의");
  });

  it("값을 아직 안 쓴 연산자는 쓰는 중으로 본다", () => {
    expect(hasIncompleteOperator("항공권 from:")).toBe(true);
    expect(hasIncompleteOperator("항공권 from:a")).toBe(false);
    expect(hasIncompleteOperator("항공권")).toBe(false);
  });
});
