import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { emptyFolder, type FolderKind } from "../../lib/ipc";
import styles from "./EmptyFolderBar.module.css";

interface Props {
  accountId: string;
  folderId: string;
  /** 휴지통·스팸함만 받는다. 다른 종류면 아무것도 그리지 않는다 */
  kind: FolderKind;
  /** 이 기기에 있는 메일 수. 서버의 전체 수와 다를 수 있다 */
  count: number;
  /** 비우기가 끝난 뒤(성공이든 실패든) 목록·안 읽은 수를 다시 읽는다 */
  onDone: () => void;
  onError: (message: string) => void;
}

const NAMES: Partial<Record<FolderKind, string>> = { trash: "휴지통", spam: "스팸함" };

/** 휴지통·스팸함 위에 뜨는 "비우기" 줄. 확인을 받은 뒤에만 `emptyFolder`를 부른다. */
export function EmptyFolderBar({ accountId, folderId, kind, count, onDone, onError }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = NAMES[kind];
  if (!name) return null;

  const run = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      await emptyFolder(accountId, folderId);
    } catch (e) {
      const message = (e as { message?: unknown } | null)?.message;
      onError(
        typeof message === "string" && message
          ? message
          : `${name}를 비우지 못했어요. 잠시 후 다시 시도해 주세요.`,
      );
    } finally {
      setBusy(false);
      onDone();
    }
  };

  return (
    <div className={styles.bar}>
      <span className={styles.hint}>{name}의 메일은 지우면 되돌릴 수 없어요.</span>
      <button
        type="button"
        className={styles.button}
        disabled={count === 0 || busy}
        onClick={() => setConfirming(true)}
      >
        {name} 비우기
      </button>
      {confirming && (
        <ConfirmDialog
          title={`${name}를 비울까요?`}
          message={`이 폴더의 모든 메일을 완전히 삭제해요(이 기기에 있는 ${count}통 포함). 되돌릴 수 없어요.`}
          confirmLabel="완전히 삭제"
          onConfirm={() => void run()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
