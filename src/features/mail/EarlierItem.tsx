import { useState } from "react";
import { getMail, toLoadError, type MailDetail } from "../../lib/ipc";
import { AttachmentList } from "./AttachmentList";
import { HtmlBody } from "./HtmlBody";
import styles from "./Reader.module.css";

type Earlier = MailDetail["earlier"][number];

type Body =
  { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; mail: MailDetail };

/** 본문 위의 이전 메일 한 줄. 누르면 그 자리에서 본문이 펼쳐지고, 다시 누르면 접힌다(Gmail처럼). */
export function EarlierItem({ item }: { item: Earlier }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<Body>();

  const load = () => {
    setBody({ kind: "loading" });
    getMail(item.id)
      .then((mail) =>
        setBody(
          mail ? { kind: "ready", mail } : { kind: "error", message: "메일을 찾을 수 없어요." },
        ),
      )
      .catch((e: unknown) => setBody({ kind: "error", message: toLoadError(e).message }));
  };

  const toggle = () => {
    if (!open && (!body || body.kind === "error")) load();
    setOpen(!open);
  };

  return (
    <>
      <button
        type="button"
        className={`ib ${styles.earlier}`}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={styles.smallAvatar}>{item.initial}</span>
        <span className={styles.earlierName}>{item.sender}</span>
        <span className={styles.earlierPreview}>{open ? "" : item.preview}</span>
        <span className={styles.date}>{item.date}</span>
      </button>
      {open && body?.kind === "loading" && <p className={styles.earlierNote}>불러오는 중…</p>}
      {open && body?.kind === "error" && (
        <p className={styles.earlierNote} role="alert">
          {body.message}
        </p>
      )}
      {open && body?.kind === "ready" && (
        <div className={styles.earlierBody}>
          {body.mail.html ? (
            <HtmlBody html={body.mail.html} />
          ) : (
            <div className={styles.content}>
              {body.mail.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
          {body.mail.attachments.length > 0 && (
            <AttachmentList mailId={body.mail.id} attachments={body.mail.attachments} />
          )}
        </div>
      )}
    </>
  );
}
