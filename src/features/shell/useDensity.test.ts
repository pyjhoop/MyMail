/// <reference types="node" />
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadDensity, ROW_HEIGHTS, saveDensity, useDensity } from "./useDensity";

const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.density;
});

describe("목록 밀도", () => {
  it("저장한 밀도를 읽고, 없으면 기본이다", () => {
    expect(loadDensity()).toBe("comfortable");
    saveDensity("compact");
    expect(loadDensity()).toBe("compact");
  });

  it("<html data-density>에 반영한다", () => {
    const { rerender } = renderHook(({ d }) => useDensity(d), {
      initialProps: { d: "comfortable" as const } as { d: "comfortable" | "compact" },
    });
    expect(document.documentElement.dataset.density).toBe("comfortable");
    rerender({ d: "compact" });
    expect(document.documentElement.dataset.density).toBe("compact");
  });

  it("행 높이 토큰이 밀도별 값과 같다", () => {
    const base = /:root\s*{[^}]*--mail-row-height:\s*(\d+)px/s.exec(tokens);
    const compact = /:root\[data-density="compact"\]\s*{[^}]*--mail-row-height:\s*(\d+)px/s.exec(
      tokens,
    );
    expect(Number(base?.[1])).toBe(ROW_HEIGHTS.comfortable);
    expect(Number(compact?.[1])).toBe(ROW_HEIGHTS.compact);
  });
});
