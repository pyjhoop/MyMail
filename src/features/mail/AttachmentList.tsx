import { Download, FolderOpen, Loader2 } from "lucide-react";
import { useState } from "react";
import {
  revealSavedAttachment,
  saveAllAttachments,
  saveAttachment,
  toLoadError,
  type MailAttachment,
} from "../../lib/ipc";
import styles from "./AttachmentList.module.css";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; count: number }
  | { kind: "error"; message: string };

const IDLE: Status = { kind: "idle" };
const OFFLINE = "인터넷에 연결되어 있지 않아 첨부파일을 받을 수 없어요.";

interface Props {
  mailId: string;
  attachments: MailAttachment[];
}

/** 첨부 카드 목록. 카드마다 저장 진행·결과를 보여 준다. 메일이 바뀌면 상태가 초기화되도록 `key`로 쓴다. */
export function AttachmentList({ mailId, attachments }: Props) {
  const [status, setStatus] = useState<Record<number, Status>>({});
  const [all, setAll] = useState<Status>(IDLE);

  const run = async (
    save: () => Promise<{ status: string; count?: number }>,
    set: (s: Status) => void,
  ) => {
    if (!navigator.onLine) {
      set({ kind: "error", message: OFFLINE });
      return;
    }
    set({ kind: "saving" });
    try {
      const result = await save();
      set(result.status === "saved" ? { kind: "saved", count: result.count ?? 1 } : IDLE);
    } catch (e) {
      set({ kind: "error", message: toLoadError(e).message });
    }
  };

  const setOne = (id: number) => (s: Status) => setStatus((prev) => ({ ...prev, [id]: s }));
  const reveal = (attachmentId?: number) =>
    revealSavedAttachment(mailId, attachmentId).catch((e) => {
      const message = toLoadError(e).message;
      if (attachmentId === undefined) setAll({ kind: "error", message });
      else setOne(attachmentId)({ kind: "error", message });
    });

  return (
    <div className={styles.wrap}>
      {attachments.length > 1 && (
        <div className={styles.allRow}>
          <button
            type="button"
            className={styles.allButton}
            disabled={all.kind === "saving"}
            onClick={() => void run(() => saveAllAttachments(mailId), setAll)}
          >
            {all.kind === "saving" ? (
              <Loader2 size={14} strokeWidth={1.75} className={styles.spin} aria-hidden />
            ) : (
              <Download size={14} strokeWidth={1.75} aria-hidden />
            )}
            모두 저장 ({attachments.length}개)
          </button>
          {all.kind === "saved" && (
            <span className={styles.ok} role="status">
              {all.count}개를 저장했어요
              <button type="button" className={styles.link} onClick={() => void reveal()}>
                폴더에서 보기
              </button>
            </span>
          )}
          {all.kind === "error" && (
            <span className={styles.error} role="alert">
              {all.message}
            </span>
          )}
        </div>
      )}
      <div className={styles.attachments}>
        {attachments.map((a) => {
          const s = status[a.id] ?? IDLE;
          const save = () => void run(() => saveAttachment(mailId, a.id), setOne(a.id));
          return (
            <div className={styles.attachment} key={a.id}>
              <span className={styles.ext}>{a.ext}</span>
              <span className={styles.attachText}>
                <span className={styles.attachName}>{a.name}</span>
                <span className={styles.size}>{a.size}</span>
                {s.kind === "saved" && (
                  <span className={styles.ok} role="status">
                    저장했어요
                    <button type="button" className={styles.link} onClick={() => void reveal(a.id)}>
                      <FolderOpen size={12} strokeWidth={1.75} aria-hidden />
                      폴더에서 보기
                    </button>
                  </span>
                )}
                {s.kind === "error" && (
                  <span className={styles.error} role="alert">
                    {s.message}
                    <button type="button" className={styles.link} onClick={save}>
                      다시 시도
                    </button>
                  </span>
                )}
              </span>
              <button
                type="button"
                className={`ib ${styles.save}`}
                aria-label={`${a.name} 저장 (${a.size})`}
                disabled={s.kind === "saving"}
                onClick={save}
              >
                {s.kind === "saving" ? (
                  <Loader2 size={16} strokeWidth={1.75} className={styles.spin} aria-hidden />
                ) : (
                  <Download size={16} strokeWidth={1.75} aria-hidden />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
