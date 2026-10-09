import { useEffect } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "mymail.theme";

export function loadTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function saveTheme(theme: ThemePreference) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // 저장 실패는 무시한다 (다음 실행에서 시스템 설정)
  }
}

/** 선택한 테마를 <html data-theme>에 반영한다. "system"이면 OS 다크 모드 설정을 따른다. */
export function useTheme(preference: ThemePreference) {
  useEffect(() => {
    if (preference !== "system") {
      document.documentElement.dataset.theme = preference;
      return;
    }
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = query.matches ? "dark" : "light";
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [preference]);
}
