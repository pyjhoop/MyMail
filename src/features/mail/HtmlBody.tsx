import { ImageOff } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { openExternal } from "../../lib/ipc";
import {
  buildMailDocument,
  isOpenableLink,
  prepareMailHtml,
  readPaperColors,
} from "../../lib/mailHtml";
import styles from "./HtmlBody.module.css";

/** 이 폭까지는 글자를 키우지 않는다. 그보다 넓은 창에서만 MAX_ZOOM까지 확대한다. */
const BASE_WIDTH = 640;
const MAX_ZOOM = 1.6;

interface Props {
  /** 정제 전 원문 HTML */
  html: string;
}

/**
 * HTML 메일 본문. 샌드박스 iframe(스크립트 불가) 안에 DOMPurify로 정제한 HTML을 넣고,
 * CSP로 외부 이미지를 막는다. 메일을 바꿀 때는 `key`로 다시 마운트해 "이미지 표시"를 초기화한다.
 */
export function HtmlBody({ html }: Props) {
  const [showImages, setShowImages] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  const prepared = useMemo(() => prepareMailHtml(html, showImages), [html, showImages]);
  const srcDoc = useMemo(
    () => buildMailDocument(prepared.html, { showImages, colors: readPaperColors() }),
    [prepared.html, showImages],
  );

  const onLoad = useCallback(() => {
    const doc = frame.current?.contentDocument;
    const el = frame.current;
    if (!doc || !el) return;

    // 폭이 넘치면 줄이고(잘림 방지), 창이 넓으면 키워서 본문이 화면 크기를 따라가게 한다.
    const fit = () => {
      const body = doc.body;
      body.style.zoom = "1";
      const width = el.clientWidth;
      const natural = doc.documentElement.scrollWidth;
      const zoom =
        natural > width + 1 ? width / natural : Math.min(Math.max(width / BASE_WIDTH, 1), MAX_ZOOM);
      body.style.zoom = String(zoom);
      el.style.height = "0px";
      el.style.height = `${Math.ceil(doc.documentElement.scrollHeight)}px`;
    };
    fit();
    // 이미지·글꼴이 늦게 로드되거나 창 크기가 바뀌면 다시 맞춘다.
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(fit);
      observer.observe(doc.body);
      observer.observe(el);
    }

    // 링크는 앱 안에서 이동하지 않고 기본 브라우저로 연다.
    doc.addEventListener("click", (e) => {
      const link = (e.target as Element | null)?.closest("a[href]");
      if (!link) return;
      e.preventDefault();
      const href = link.getAttribute("href") ?? "";
      if (isOpenableLink(href)) void openExternal(href);
    });
  }, []);

  return (
    <div className={styles.wrap}>
      {prepared.externalImages > 0 && !showImages && (
        <div className={styles.banner} role="status">
          <ImageOff size={16} strokeWidth={1.75} aria-hidden />
          <span className={styles.bannerText}>개인정보 보호를 위해 외부 이미지를 차단했어요.</span>
          <button type="button" className={styles.show} onClick={() => setShowImages(true)}>
            이미지 표시
          </button>
        </div>
      )}
      <iframe
        ref={frame}
        className={styles.frame}
        title="메일 본문"
        // allow-same-origin은 높이 계산과 링크 가로채기용이다. allow-scripts가 없어 스크립트는 실행되지 않는다.
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        onLoad={onLoad}
      />
    </div>
  );
}
