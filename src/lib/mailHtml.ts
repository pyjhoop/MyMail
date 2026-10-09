// HTML 메일 정제와 iframe 문서 조립. 화면과 무관한 순수 함수.
import DOMPurify from "dompurify";

export interface PreparedHtml {
  /** 정제를 마친 본문 HTML */
  html: string;
  /** 외부 이미지 개수 (차단 중이면 src를 떼어낸 수) */
  externalImages: number;
}

const EXTERNAL_URL = /^\s*(https?:)?\/\//i;
const CSS_EXTERNAL_URL = /url\(\s*["']?\s*(https?:)?\/\//i;

/**
 * 원문 HTML을 정제한다. 스크립트·이벤트 핸들러·폼·프레임은 제거하고,
 * `showImages`가 false면 외부 이미지(img, background, 인라인 스타일)의 주소를 뗀다.
 * iframe CSP가 한 번 더 막으므로 여기서는 개수 집계와 깨진 이미지 표시 방지가 목적이다.
 */
export function prepareMailHtml(raw: string, showImages: boolean): PreparedHtml {
  const clean = DOMPurify.sanitize(raw, {
    FORCE_BODY: true, // 맨 앞의 <style>이 버려지지 않게 한다
    FORBID_TAGS: [
      "form",
      "input",
      "button",
      "select",
      "textarea",
      "iframe",
      "frame",
      "object",
      "embed",
      "link",
      "meta",
      "base",
    ],
    FORBID_ATTR: ["srcdoc", "target", "ping"],
    ALLOW_DATA_ATTR: false,
  });

  const doc = new DOMParser().parseFromString(clean, "text/html");
  let externalImages = 0;

  const block = (el: Element, attr: string) => {
    externalImages += 1;
    if (!showImages) el.removeAttribute(attr);
  };

  doc.querySelectorAll("img[src]").forEach((el) => {
    if (EXTERNAL_URL.test(el.getAttribute("src") ?? "")) block(el, "src");
  });
  doc.querySelectorAll("img[srcset]").forEach((el) => {
    el.removeAttribute("srcset"); // 후보가 여럿이라 한꺼번에 막는다
  });
  doc.querySelectorAll("[background]").forEach((el) => {
    if (EXTERNAL_URL.test(el.getAttribute("background") ?? "")) block(el, "background");
  });
  doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const style = el.getAttribute("style") ?? "";
    if (CSS_EXTERNAL_URL.test(style)) {
      externalImages += 1;
      if (!showImages) el.setAttribute("style", style.replace(/url\([^)]*\)/gi, "none"));
    }
  });

  // 맨 앞의 <style>은 파서가 <head>로 옮기므로 함께 되돌려 놓는다.
  const headStyles = Array.from(doc.head.querySelectorAll("style"), (s) => s.outerHTML).join("");
  return { html: headStyles + doc.body.innerHTML, externalImages };
}

export interface PaperColors {
  background: string;
  text: string;
  link: string;
  fontFamily: string;
}

/** tokens.css의 값을 읽는다. iframe 안에는 앱 CSS 변수가 닿지 않아 값으로 넘겨야 한다. */
export function readPaperColors(): PaperColors {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: get("--mail-paper-bg"),
    text: get("--mail-paper-text"),
    link: get("--mail-paper-link"),
    fontFamily: get("--font-sans"),
  };
}

/** iframe `srcdoc`에 넣을 문서. CSP가 스크립트와 (필요하면) 외부 이미지를 막는다. */
export function buildMailDocument(
  body: string,
  { showImages, colors }: { showImages: boolean; colors: PaperColors },
): string {
  const img = showImages ? "data: https: http:" : "data:";
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
html { color-scheme: light; overflow-y: hidden; }
body { margin: 0; padding: 16px; background: ${colors.background}; color: ${colors.text};
  font: 14px/1.6 ${colors.fontFamily}; overflow-wrap: break-word; }
a { color: ${colors.link}; }
img { max-width: 100%; height: auto; }
blockquote { margin-left: 0; padding-left: 12px; border-left: 3px solid #d4d4d8; }
</style></head><body>${body}</body></html>`;
}

/** 클릭해도 앱 안에서 이동하지 않고 기본 앱으로 열 수 있는 주소만 통과시킨다. */
export function isOpenableLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}
