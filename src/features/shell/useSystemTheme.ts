import { useEffect } from "react";

/** OS 다크 모드 설정을 따라 <html data-theme>을 바꾼다. */
export function useSystemTheme() {
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = query.matches ? "dark" : "light";
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
}
