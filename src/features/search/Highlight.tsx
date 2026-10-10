import { Fragment } from "react";
import { splitByTerms } from "./splitByTerms";
import styles from "./Highlight.module.css";

/**
 * 글에서 검색어와 겹치는 부분을 `<mark>`로 감싼다.
 * 문자열을 잘라 React 텍스트 노드로 그리므로 메일 내용이 HTML로 해석될 일이 없다.
 */
export function Highlight({ text, terms }: { text: string; terms: readonly string[] }) {
  const parts = splitByTerms(text, terms);
  if (parts.length === 1 && !parts[0].hit) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className={styles.mark}>
            {p.text}
          </mark>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
