import { Ellipsis, Paperclip, PenLine, Send, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatListTime, formatSize } from "../../lib/format";
import {
  addDraftAttachment,
  discardDraft,
  removeDraftAttachment,
  saveDraft,
  sendDraft,
  setSignature,
  toLoadError,
  type Account,
  type Draft,
  type DraftFields,
} from "../../lib/ipc";
import { isEmptyDraft, isValidAddress, splitAddresses, swapSignature } from "./compose";
import styles from "./Composer.module.css";
import { RecipientField } from "./RecipientField";

/** 이보다 큰 파일은 읽지도 않고 거절한다 (어느 서비스든 이 이상은 받아주지 않는다). */
const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** 마지막 입력 뒤 이만큼 지나면 임시저장한다. */
const AUTOSAVE_MS = 1500;

export type ComposeResult = "sent" | "kept" | "discarded";

export interface ComposeInit {
  draft: Draft;
  /** 작성기가 처음 채워 준 제목·본문(서명·인용). 이것만 있으면 빈 메일로 본다. 저장해 둔 임시 메일을 열 땐 비운다. */
  seed: { subject: string; body: string };
  /** 본문 위에 보여줄 안내 */
  notice?: string;
}

interface Props {
  accounts: Account[];
  init: ComposeInit;
  onClose: (result: ComposeResult) => void;
  /** 서명을 저장했을 때 (계정 목록의 서명을 맞추기 위해) */
  onSignatureSaved: (accountId: string, signature: string) => void;
}

type SaveState =
  { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: number } | { kind: "error" };

const extOf = (name: string) =>
  (name.includes(".") ? (name.split(".").pop() ?? "") : "").slice(0, 4);

export function Composer({ accounts, init, onClose, onSignatureSaved }: Props) {
  const { draft: initial, seed, notice } = init;
  const [fields, setFields] = useState<DraftFields>({
    id: initial.id,
    accountId: initial.accountId,
    to: initial.to,
    cc: initial.cc,
    bcc: initial.bcc,
    subject: initial.subject,
    body: initial.body,
    quoteHeader: initial.quoteHeader,
    quoteText: initial.quoteText,
  });
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [texts, setTexts] = useState({ to: "", cc: "", bcc: "" });
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const [attachments, setAttachments] = useState(initial.attachments);
  const [touched, setTouched] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [attachError, setAttachError] = useState<string>();
  const [editingSignature, setEditingSignature] = useState(false);
  const [signatureText, setSignatureText] = useState("");

  const account = accounts.find((a) => a.id === fields.accountId) ?? accounts[0];
  const failedBefore = !touched && initial.status === "failed" ? initial.error : null;

  // 언마운트 때(다른 메일을 고르는 등) 쓰는 최신 값
  const latest = useRef({ fields, touched });
  const finished = useRef(false);
  useEffect(() => {
    latest.current = { fields, touched };
  });

  const persist = useCallback(async (next?: DraftFields) => {
    setSave({ kind: "saving" });
    try {
      await saveDraft(next ?? latest.current.fields);
      setSave({ kind: "saved", at: Math.floor(Date.now() / 1000) });
      return true;
    } catch {
      setSave({ kind: "error" });
      return false;
    }
  }, []);

  useEffect(() => {
    if (!touched) return;
    const timer = setTimeout(() => void persist(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [fields, touched, persist]);

  // 닫지 않고 화면을 벗어나도(다른 메일 선택 등) 쓰던 내용은 남긴다.
  useEffect(
    () => () => {
      const { fields: last, touched: edited } = latest.current;
      if (edited && !finished.current) void saveDraft(last).catch(() => undefined);
    },
    [],
  );

  const update = (patch: Partial<DraftFields>) => {
    setFields((f) => ({ ...f, ...patch }));
    setTouched(true);
    setError(undefined);
  };

  const changeAccount = (accountId: string) => {
    const next = accounts.find((a) => a.id === accountId);
    if (!next || !account) return;
    update({ accountId, body: swapSignature(fields.body, account.signature, next.signature) });
  };

  /** 입력창에 남은 글자도 주소로 확정한 목록 */
  const committed = () => ({
    to: [...fields.to, ...splitAddresses(texts.to)],
    cc: [...fields.cc, ...splitAddresses(texts.cc)],
    bcc: [...fields.bcc, ...splitAddresses(texts.bcc)],
  });

  const send = async () => {
    if (sending) return;
    const lists = committed();
    const everyone = [...lists.to, ...lists.cc, ...lists.bcc];
    if (everyone.length === 0) return setError("받는사람을 입력해 주세요.");
    const bad = everyone.find((a) => !isValidAddress(a));
    if (bad) return setError(`올바르지 않은 메일 주소가 있어요: ${bad}`);

    setSending(true);
    setError(undefined);
    setTexts({ to: "", cc: "", bcc: "" });
    const next = { ...fields, ...lists };
    setFields(next);
    try {
      await saveDraft(next);
      await sendDraft(next.id);
      finished.current = true;
      onClose("sent");
    } catch (e) {
      setError(`메일을 보내지 못했어요. ${toLoadError(e).message}`);
      setSending(false);
    }
  };

  const discard = async () => {
    finished.current = true;
    await discardDraft(fields.id).catch(() => undefined);
    onClose("discarded");
  };

  const close = async () => {
    const empty = isEmptyDraft(committedFields(), seed, attachments.length);
    if (empty) return discard();
    if (touched) await persist();
    finished.current = true;
    onClose("kept");
  };

  const committedFields = () => ({ ...fields, ...committed() });

  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttachError(undefined);
    setTouched(true);
    // 첨부는 저장된 메일에 붙으므로 메일이 먼저 있어야 한다.
    if (!(await persist(committedFields()))) {
      return setAttachError("임시저장하지 못해 첨부할 수 없어요.");
    }
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_BYTES) {
        setAttachError(`${file.name}: 파일이 너무 커요. 30MB 이하만 첨부할 수 있어요.`);
        continue;
      }
      try {
        const id = await addDraftAttachment(fields.id, file);
        setAttachments((a) => [...a, { id, name: file.name, size: file.size }]);
      } catch (e) {
        setAttachError(`${file.name}: ${toLoadError(e).message}`);
      }
    }
  };

  const detach = async (attachmentId: number) => {
    try {
      await removeDraftAttachment(fields.id, attachmentId);
      setAttachments((a) => a.filter((x) => x.id !== attachmentId));
    } catch (e) {
      setAttachError(toLoadError(e).message);
    }
  };

  const saveSignature = async () => {
    if (!account) return;
    try {
      await setSignature(account.id, signatureText);
      const trimmed = signatureText.trimEnd();
      update({ body: swapSignature(fields.body, account.signature, trimmed) });
      onSignatureSaved(account.id, trimmed);
      setEditingSignature(false);
    } catch (e) {
      setError(toLoadError(e).message);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  };

  const message = error ?? (failedBefore ? `이전에 보내지 못했어요. ${failedBefore}` : undefined);
  const saveLabel =
    save.kind === "saving"
      ? "저장 중…"
      : save.kind === "saved"
        ? `임시저장됨 · ${formatListTime(save.at)}`
        : save.kind === "error"
          ? "임시저장하지 못했어요"
          : "";
  const retry = initial.status === "failed" || (error?.startsWith("메일을 보내지") ?? false);

  return (
    <main className={styles.composer} onKeyDown={onKeyDown}>
      <section className={styles.sheet} aria-label="메일 작성">
        <div className={styles.header}>
          {account && (
            <label className={styles.account}>
              <span
                className={styles.dot}
                style={{ background: `var(--account-${account.colorIndex})` }}
                aria-hidden
              />
              <span className="sr-only">보내는 계정</span>
              <select
                className={styles.select}
                value={account.id}
                onChange={(e) => changeAccount(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.email}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className={styles.grow} />
          <button
            type="button"
            className={`ib ${styles.iconButton}`}
            aria-label="서명 편집"
            title="서명 편집"
            onClick={() => {
              setSignatureText(account?.signature ?? "");
              setEditingSignature((v) => !v);
            }}
          >
            <PenLine size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            className={`ib ${styles.iconButton}`}
            aria-label="임시보관 삭제"
            title="이 메일 버리기"
            onClick={() => void discard()}
          >
            <Trash2 size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            className={`ib ${styles.iconButton}`}
            aria-label="작성 닫기"
            title="닫기 (임시저장됨)"
            onClick={() => void close()}
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

        {editingSignature && (
          <div className={styles.signature}>
            <label htmlFor="signature-text" className={styles.signatureLabel}>
              {account?.name} 서명
            </label>
            <textarea
              id="signature-text"
              className={styles.signatureText}
              rows={3}
              value={signatureText}
              placeholder="새 메일과 답장 끝에 자동으로 들어가요"
              onChange={(e) => setSignatureText(e.target.value)}
            />
            <div className={styles.signatureActions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setEditingSignature(false)}
              >
                취소
              </button>
              <button type="button" className={styles.primary} onClick={() => void saveSignature()}>
                서명 저장
              </button>
            </div>
          </div>
        )}

        {message && (
          <div className={styles.alert} role="alert">
            {message}
          </div>
        )}
        {notice && <div className={styles.notice}>{notice}</div>}

        <div className={styles.recipients}>
          <div className={styles.recipientRow}>
            <RecipientField
              label="받는사람"
              value={fields.to}
              onChange={(to) => update({ to })}
              text={texts.to}
              onTextChange={(to) => setTexts((t) => ({ ...t, to }))}
              autoFocus={fields.to.length === 0}
            />
            {(!showCc || !showBcc) && (
              <div className={styles.toggles}>
                {!showCc && (
                  <button
                    type="button"
                    className={`ib ${styles.toggle}`}
                    onClick={() => setShowCc(true)}
                  >
                    참조
                  </button>
                )}
                {!showBcc && (
                  <button
                    type="button"
                    className={`ib ${styles.toggle}`}
                    onClick={() => setShowBcc(true)}
                  >
                    숨은참조
                  </button>
                )}
              </div>
            )}
          </div>
          {showCc && (
            <RecipientField
              label="참조"
              value={fields.cc}
              onChange={(cc) => update({ cc })}
              text={texts.cc}
              onTextChange={(cc) => setTexts((t) => ({ ...t, cc }))}
            />
          )}
          {showBcc && (
            <RecipientField
              label="숨은참조"
              value={fields.bcc}
              onChange={(bcc) => update({ bcc })}
              text={texts.bcc}
              onTextChange={(bcc) => setTexts((t) => ({ ...t, bcc }))}
            />
          )}
        </div>

        <div className={styles.subjectRow}>
          <label htmlFor="compose-subject" className={styles.subjectLabel}>
            제목
          </label>
          <input
            id="compose-subject"
            className={styles.subject}
            value={fields.subject}
            onChange={(e) => update({ subject: e.target.value })}
          />
        </div>

        <textarea
          className={styles.body}
          aria-label="본문"
          value={fields.body}
          onChange={(e) => update({ body: e.target.value })}
        />

        {fields.quoteText && (
          <div className={styles.quote}>
            <button
              type="button"
              className={`ib ${styles.quoteToggle}`}
              aria-expanded={quoteOpen}
              aria-label={quoteOpen ? "인용 접기" : "인용 펼치기"}
              title={quoteOpen ? "인용 접기" : "인용 펼치기"}
              onClick={() => setQuoteOpen((v) => !v)}
            >
              <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
            </button>
            {quoteOpen && (
              <blockquote className={styles.quoteBlock} data-testid="quote-block">
                {fields.quoteHeader && <p className={styles.quoteHeader}>{fields.quoteHeader}</p>}
                <div className={styles.quoteText}>{fields.quoteText}</div>
              </blockquote>
            )}
          </div>
        )}

        {(attachments.length > 0 || attachError) && (
          <div className={styles.attachments}>
            {attachments.map((a) => (
              <div className={styles.attachment} key={a.id}>
                <span className={styles.ext}>{extOf(a.name)}</span>
                <span className={styles.attachName}>{a.name}</span>
                <span className={styles.attachSize}>{formatSize(a.size)}</span>
                <button
                  type="button"
                  className={`ib ${styles.attachRemove}`}
                  aria-label={`${a.name} 첨부 삭제`}
                  onClick={() => void detach(a.id)}
                >
                  <X size={14} strokeWidth={2} aria-hidden />
                </button>
              </div>
            ))}
            {attachError && (
              <div className={styles.attachError} role="alert">
                {attachError}
              </div>
            )}
          </div>
        )}

        <div className={styles.footer}>
          <span className={styles.saveState} role="status">
            {saveLabel}
          </span>
          <span className={styles.grow} />
          <label className={`ib ${styles.attachButton}`}>
            <Paperclip size={16} strokeWidth={1.75} aria-hidden />
            파일 첨부
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => {
                void attach(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <span className={styles.shortcut}>Ctrl + Enter</span>
          <button
            type="button"
            className={styles.send}
            disabled={sending}
            onClick={() => void send()}
          >
            <Send size={16} strokeWidth={2} aria-hidden />
            {sending ? "보내는 중…" : retry ? "다시 보내기" : "보내기"}
          </button>
        </div>
      </section>
    </main>
  );
}
