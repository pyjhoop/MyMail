import { useEffect } from "react";

/** 메일 목록 밀도: 기본(3줄) / 컴팩트(1줄) */
export type Density = "comfortable" | "compact";

const STORAGE_KEY = "mymail.density";

/** 밀도별 목록 행 높이(px). `tokens.css`의 `--mail-row-height`와 같아야 한다(테스트가 대조한다). */
export const ROW_HEIGHTS: Record<Density, number> = { comfortable: 84, compact: 40 };

export function loadDensity(): Density {
  try {
    return localStorage.getItem(STORAGE_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function saveDensity(density: Density) {
  try {
    localStorage.setItem(STORAGE_KEY, density);
  } catch {
    // 저장 실패는 무시한다 (다음 실행에서 기본 밀도)
  }
}

/** 선택한 밀도를 <html data-density>에 반영한다. CSS 토큰이 이 값을 보고 행 높이를 바꾼다. */
export function useDensity(density: Density) {
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);
}
