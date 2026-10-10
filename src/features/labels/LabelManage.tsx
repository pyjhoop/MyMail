import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import dialog from "../../components/ConfirmDialog.module.css";
import { createLabel, deleteLabel, renameLabel, toLoadError, type Folder } from "../../lib/ipc";
import styles from "./LabelManage.module.css";

/** 폴더 패널에서 연 라벨 관리 창 */
export type LabelManageTarget =
  | { kind: "create" }
  | { kind: "rename"; folder: Folder; path: string }
  | { kind: "delete"; folder: Folder; path: string };

interface Props {
  accountId: string;
  target: LabelManageTarget;
  onClose: () => void;
  /** 서버에 반영한 뒤. 화면이 폴더 목록·메일 목록을 다시 읽는다 */
  onDone: () => void;
  /** 확인 창에서 실패했을 때의 안내(이름 창은 창 안에 보인다) */
  onError: (message: string) => void;
}

/** 라벨 만들기·이름 바꾸기 창과 삭제 확인 창. 서버가 거절하면 한국어 안내를 창 안에 보인다. */
export function LabelManage({ accountId, target, onClose, onDone, onError }: Props) {
  if (target.kind === "delete") {
    return (
      <ConfirmDialog
        title="라벨을 삭제할까요?"
        message={`"${target.path}" 라벨을 지워요. 이 라벨이 붙은 메일은 지워지지 않고 라벨만 떨어져요.`}
        confirmLabel="삭제"
        onCancel={onClose}
        onConfirm={() => {
          onClose();
          deleteLabel(accountId, target.folder.id)
            .then(onDone)
            .catch((e: unknown) => onError(`라벨을 삭제하지 못했어요. ${toLoadError(e).message}`));
        }}
      />
    );
  }
  return <NameDialog accountId={accountId} target={target} onClose={onClose} onDone={onDone} />;
}

function NameDialog({
  accountId,
  target,
  onClose,
  onDone,
}: Pick<Props, "accountId" | "onClose" | "onDone"> & {
  target: Exclude<LabelManageTarget, { kind: "delete" }>;
}) {
  const renaming = target.kind === "rename";
  const [name, setName] = useState(renaming ? target.path : "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (renaming) await renameLabel(accountId, target.folder.id, name);
      else await createLabel(accountId, name);
      onClose();
      onDone();
    } catch (err) {
      setError(toLoadError(err).message);
      setBusy(false);
    }
  };

  return (
    <div className={dialog.scrim}>
      <form
        className={dialog.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => void submit(e)}
      >
        <h2 id={titleId} className={dialog.title}>
          {renaming ? "라벨 이름 바꾸기" : "새 라벨 만들기"}
        </h2>
        <p className={dialog.message}>
          {renaming ? "하위 라벨도 함께 바뀌어요." : "`부모/자식` 꼴로 쓰면 하위 라벨이 돼요."}
        </p>
        <input
          ref={input}
          className={styles.input}
          aria-label="라벨 이름"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={dialog.footer}>
          <button type="button" className={dialog.secondary} onClick={onClose}>
            취소
          </button>
          <button type="submit" className={styles.primary} disabled={busy || name.trim() === ""}>
            {renaming ? "바꾸기" : "만들기"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface MenuProps {
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/** 폴더 패널의 라벨 행을 우클릭하면 뜨는 메뉴 */
export function LabelContextMenu({ x, y, onRename, onDelete, onClose }: MenuProps) {
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={menu}
      role="menu"
      aria-label="라벨 메뉴"
      className={styles.menu}
      style={{ left: x, top: y }}
    >
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        이름 바꾸기
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        onClick={() => {
          onClose();
          onDelete();
        }}
      >
        삭제
      </button>
    </div>
  );
}
