import { describe, expect, it } from "vitest";
import type { Folder } from "./ipc";
import { labelColor, labelColorVar, labelPaths } from "./labels";

const label = (id: string, name: string, depth = 0): Folder => ({
  id,
  accountId: "a1",
  name,
  kind: "label",
  unread: 0,
  depth,
});

describe("labelColor", () => {
  it("같은 이름은 언제나 같은 색이고 1~8 안이다", () => {
    for (const name of ["Work", "여행", "Work/Sub", "a"]) {
      expect(labelColor(name)).toBe(labelColor(name));
      expect(labelColor(name)).toBeGreaterThanOrEqual(1);
      expect(labelColor(name)).toBeLessThanOrEqual(8);
    }
  });

  it("백엔드 label_color와 같은 값을 낸다", () => {
    expect(labelColor("Work")).toBe(2);
    expect(labelColor("여행")).toBe(8);
    expect(labelColor("Work/Sub")).toBe(3);
  });

  it("색 값은 토큰 변수로만 나온다", () => {
    expect(labelColorVar("Work")).toBe("var(--account-2)");
  });
});

describe("labelPaths", () => {
  it("깊이로 부모/자식 전체 이름을 만든다", () => {
    const paths = labelPaths([
      label("1", "Work"),
      label("2", "Sub", 1),
      label("3", "Deep", 2),
      label("4", "Other"),
      label("5", "Child", 1),
    ]);
    expect(paths.get("2")).toBe("Work/Sub");
    expect(paths.get("3")).toBe("Work/Sub/Deep");
    expect(paths.get("4")).toBe("Other");
    expect(paths.get("5")).toBe("Other/Child");
  });
});
