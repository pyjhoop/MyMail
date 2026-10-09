import styles from "./Toast.module.css";

interface Props {
  message: string;
  /** 있으면 메시지 옆에 버튼을 둔다 ("실행 취소") */
  actionLabel?: string;
  onAction?: () => void;
}

/** 화면 하단에 잠깐 떠 있는 알림. 스크린리더에는 `status`로 읽힌다. */
export function Toast({ message, actionLabel, onAction }: Props) {
  return (
    <div className={styles.toast} role="status">
      <span>{message}</span>
      {actionLabel && onAction && (
        <button type="button" className={styles.action} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
