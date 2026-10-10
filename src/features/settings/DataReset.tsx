import { useId, useState } from "react";
import dialog from "../../components/ConfirmDialog.module.css";
import { resetData, toLoadError, type ResetScope } from "../../lib/ipc";
import styles from "./DataReset.module.css";

/** 모든 데이터 초기화 때 입력해야 하는 확인 문구 */
export const RESET_PHRASE = "초기화";

interface Props {
  /** 초기화가 끝난 뒤 화면을 처음 상태로 되돌리는 일은 앱이 맡는다 */
  onDone: (scope: ResetScope) => void;
}

const COPY: Record<ResetScope, { title: string; message: string; confirm: string }> = {
  cache: {
    title: "메일 캐시를 지울까요?",
    message:
      "이 기기에 저장된 메일을 지워요. 계정과 비밀번호는 그대로 두고, 다음 동기화 때 서버에서 다시 받아요. 서버의 메일은 그대로예요.",
    confirm: "캐시 지우기",
  },
  all: {
    title: "모든 데이터를 초기화할까요?",
    message:
      "계정, 저장된 비밀번호, 메일 캐시, 설정, 최근 검색이 모두 지워지고 처음 실행 상태로 돌아가요. 되돌릴 수 없어요. 서버의 메일은 그대로예요.",
    confirm: "모두 초기화",
  },
};

/** 설정 > 일반 맨 아래 "위험 영역" */
export function DataReset({ onDone }: Props) {
  const [asking, setAsking] = useState<ResetScope>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (scope: ResetScope) => {
    setBusy(true);
    setError(undefined);
    try {
      await resetData(scope);
      if (scope === "all") {
        try {
          localStorage.clear();
        } catch {
          // 저장소를 쓸 수 없는 환경이면 지울 것도 없다.
        }
      }
      setAsking(undefined);
      onDone(scope);
    } catch (e) {
      setError(toLoadError(e).message);
      setAsking(undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.zone} aria-label="위험 영역">
      <h2 className={styles.zoneTitle}>위험 영역</h2>
      <div className={styles.item}>
        <div className={styles.itemText}>
          <span className={styles.itemName}>메일 캐시만 지우기</span>
          <span className={styles.hint}>계정과 비밀번호는 두고, 메일은 서버에서 다시 받아요.</span>
        </div>
        <button
          type="button"
          className={styles.dangerButton}
          disabled={busy}
          onClick={() => setAsking("cache")}
        >
          메일 캐시 지우기
        </button>
      </div>
      <div className={styles.item}>
        <div className={styles.itemText}>
          <span className={styles.itemName}>모든 데이터 초기화</span>
          <span className={styles.hint}>
            계정·비밀번호·설정까지 지우고 처음 실행 상태로 돌아가요.
          </span>
        </div>
        <button
          type="button"
          className={styles.dangerButton}
          disabled={busy}
          onClick={() => setAsking("all")}
        >
          데이터 초기화
        </button>
      </div>
      {busy && (
        <p role="status" className={styles.hint}>
          지우는 중…
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {asking && (
        <ResetConfirm
          scope={asking}
          busy={busy}
          onConfirm={() => void run(asking)}
          onCancel={() => setAsking(undefined)}
        />
      )}
    </section>
  );
}

function ResetConfirm({
  scope,
  busy,
  onConfirm,
  onCancel,
}: {
  scope: ResetScope;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [phrase, setPhrase] = useState("");
  const copy = COPY[scope];
  const needsPhrase = scope === "all";
  const ready = !busy && (!needsPhrase || phrase.trim() === RESET_PHRASE);

  return (
    <div
      className={dialog.scrim}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className={dialog.dialog} role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className={dialog.title}>
          {copy.title}
        </h2>
        <p className={dialog.message}>{copy.message}</p>
        {needsPhrase && (
          <label className={dialog.message}>
            계속하려면 &quot;{RESET_PHRASE}&quot;를 입력하세요.
            <input
              className={styles.input}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              aria-label="확인 문구"
              autoFocus
            />
          </label>
        )}
        <div className={dialog.footer}>
          <button type="button" className={dialog.secondary} onClick={onCancel}>
            취소
          </button>
          <button type="button" className={dialog.danger} disabled={!ready} onClick={onConfirm}>
            {copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
