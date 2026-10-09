import {
  Archive,
  ChevronDown,
  ChevronUp,
  Forward,
  Reply,
  ReplyAll,
  Star,
  Trash2,
} from "lucide-react";
import { NoMailSelected, ReaderSkeleton } from "../../components/StateView";
import type { MailDetail } from "../../lib/ipc";
import { AttachmentList } from "./AttachmentList";
import { HtmlBody } from "./HtmlBody";
import { MoreMenu, type MoreMenuProps } from "./MoreMenu";
import styles from "./Reader.module.css";

/** 도구 모음의 보관·삭제·더보기. 동작은 App이 정하고 Reader는 버튼만 그린다. */
export interface ReaderActions {
  onDelete: () => void;
  onArchive: () => void;
  /** 있으면 보관 버튼을 막고 이 문구를 툴팁으로 보여 준다 */
  archiveBlockedReason?: string;
  more: Omit<MoreMenuProps, "disabled" | "unread" | "starred">;
}

interface Props {
  mail: MailDetail | null;
  loading: boolean;
  /** "3 / 48" 같은 목록 위치 표시 */
  position?: string;
  onPrev: () => void;
  onNext: () => void;
  onCompose: (mode: "reply" | "replyAll" | "forward") => void;
  actions?: ReaderActions;
}

export function Reader({ mail, loading, position, onPrev, onNext, onCompose, actions }: Props) {
  const ready = !!mail && !!actions;
  return (
    <main className={styles.reader}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={`ib ${styles.text}`}
          disabled={!mail}
          onClick={() => onCompose("reply")}
        >
          <Reply size={20} strokeWidth={1.75} aria-hidden />
          답장
        </button>
        <button
          type="button"
          className={`ib ${styles.text}`}
          disabled={!mail}
          onClick={() => onCompose("replyAll")}
        >
          <ReplyAll size={20} strokeWidth={1.75} aria-hidden />
          전체 답장
        </button>
        <button
          type="button"
          className={`ib ${styles.text}`}
          disabled={!mail}
          onClick={() => onCompose("forward")}
        >
          <Forward size={20} strokeWidth={1.75} aria-hidden />
          전달
        </button>
        <span className={styles.sep} />
        <button
          type="button"
          className={`ib ${styles.icon}`}
          aria-label="보관"
          title={actions?.archiveBlockedReason}
          disabled={!ready || !!actions.archiveBlockedReason}
          onClick={actions?.onArchive}
        >
          <Archive size={20} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          className={`ib ${styles.icon}`}
          aria-label="삭제"
          disabled={!ready}
          onClick={actions?.onDelete}
        >
          <Trash2 size={20} strokeWidth={1.75} aria-hidden />
        </button>
        <MoreMenu
          disabled={!ready}
          unread={mail?.unread ?? false}
          starred={mail?.starred ?? false}
          moveTargets={actions?.more.moveTargets ?? []}
          spam={actions?.more.spam}
          onSetRead={(read) => actions?.more.onSetRead(read)}
          onSetStarred={(starred) => actions?.more.onSetStarred(starred)}
          onMove={(folder) => actions?.more.onMove(folder)}
          onToggleSpam={() => actions?.more.onToggleSpam()}
        />
        <span className={styles.grow} />
        {position && <span className={styles.position}>{position}</span>}
        <button
          type="button"
          className={`ib ${styles.nav}`}
          aria-label="이전 메일"
          onClick={onPrev}
        >
          <ChevronUp size={18} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          className={`ib ${styles.nav}`}
          aria-label="다음 메일"
          onClick={onNext}
        >
          <ChevronDown size={18} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      {loading && <ReaderSkeleton />}
      {!loading && !mail && <NoMailSelected />}
      {!loading && mail && (
        <div className={styles.scroll}>
          <article className={`${styles.article} ${mail.html ? styles.wide : ""}`}>
            <div className={styles.titleRow}>
              <h1>{mail.subject}</h1>
              {mail.starred && (
                <Star
                  className={styles.star}
                  size={18}
                  strokeWidth={1.75}
                  fill="currentColor"
                  role="img"
                  aria-label="별표 표시됨"
                />
              )}
              {mail.label && (
                <span className={styles.chip}>
                  <span
                    className={styles.chipDot}
                    style={{ background: `var(--account-${mail.label.colorIndex})` }}
                  />
                  {mail.label.name}
                </span>
              )}
            </div>

            {mail.earlier.map((e) => (
              <button type="button" className={`ib ${styles.earlier}`} key={e.date}>
                <span className={styles.smallAvatar}>{e.initial}</span>
                <span className={styles.earlierName}>{e.sender}</span>
                <span className={styles.earlierPreview}>{e.preview}</span>
                <span className={styles.date}>{e.date}</span>
              </button>
            ))}
            {mail.earlier.length > 0 && <div className={styles.divider} />}

            <div className={styles.header}>
              <span className={styles.avatar}>{mail.sender.slice(0, 1)}</span>
              <div className={styles.headerText}>
                <div className={styles.fromRow}>
                  <span className={styles.from}>{mail.sender}</span>
                  <span className={styles.date}>{mail.senderEmail}</span>
                  <span className={styles.grow} />
                  <span className={styles.date}>{mail.fullTime}</span>
                </div>
                <div className={styles.date}>받는사람: {mail.to}</div>
              </div>
            </div>

            {mail.html ? (
              <HtmlBody key={mail.id} html={mail.html} />
            ) : (
              <div className={styles.content}>
                {mail.body.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </div>
            )}

            {mail.attachments.length > 0 && (
              <AttachmentList key={mail.id} mailId={mail.id} attachments={mail.attachments} />
            )}
          </article>
        </div>
      )}
    </main>
  );
}
