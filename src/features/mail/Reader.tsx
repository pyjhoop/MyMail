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
import type { ReactNode } from "react";
import { NoMailSelected, ReaderSkeleton } from "../../components/StateView";
import type { MailDetail } from "../../lib/ipc";
import { LabelChips } from "../labels/LabelChips";
import { AttachmentList } from "./AttachmentList";
import { HtmlBody } from "./HtmlBody";
import { MoreMenu, type MoreMenuProps } from "./MoreMenu";
import { Highlight } from "../search/Highlight";
import styles from "./Reader.module.css";

const NO_TERMS: readonly string[] = [];

/** 도구 모음의 보관·삭제·더보기. 동작은 App이 정하고 Reader는 버튼만 그린다. */
export interface ReaderActions {
  onDelete: () => void;
  onArchive: () => void;
  /** 있으면 보관 버튼을 막고 이 문구를 툴팁으로 보여 준다 */
  archiveBlockedReason?: string;
  /** 라벨 버튼(라벨을 지원하는 계정에서만 그려진다). 팝오버 동작은 `features/labels`가 맡는다 */
  labelButton?: ReactNode;
  /** 헤더의 라벨 칩 ×를 눌렀을 때. 없으면 × 없이 칩만 보인다 */
  onRemoveLabel?: (name: string) => void;
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
  /** 검색 결과에서 연 메일이면: 본문에서 강조할 단어, 검색어 칩, 계정·폴더 표시 */
  search?: {
    terms: readonly string[];
    query: string;
    /** 계정 색(CSS 값)과 "개인 Gmail · 받은편지함" 같은 위치 */
    place?: { color: string; label: string };
  };
}

export function Reader({
  mail,
  loading,
  position,
  onPrev,
  onNext,
  onCompose,
  actions,
  search,
}: Props) {
  const terms = search?.terms ?? NO_TERMS;
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
        {actions?.labelButton}
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
            {search && (
              <div className={styles.context}>
                {search.place && (
                  <>
                    <span
                      className={styles.contextDot}
                      style={{ background: search.place.color }}
                    />
                    <span>{search.place.label}</span>
                  </>
                )}
                <span className={styles.searchChip} title="검색어">
                  ‘{search.query}’
                </span>
              </div>
            )}
            <div className={styles.titleRow}>
              <h1>
                <Highlight text={mail.subject} terms={terms} />
              </h1>
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
              <LabelChips labels={mail.labels} onRemove={actions?.onRemoveLabel} />
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
              <HtmlBody key={mail.id} html={mail.html} highlight={terms} />
            ) : (
              <div className={styles.content}>
                {mail.body.map((p) => (
                  <p key={p}>
                    <Highlight text={p} terms={terms} />
                  </p>
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
