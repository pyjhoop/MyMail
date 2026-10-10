import { X } from "lucide-react";
import { labelColorVar } from "../../lib/labels";
import styles from "./LabelChips.module.css";

interface Props {
  labels: { name: string }[];
  /** 있으면 칩마다 × 버튼을 둔다(메일에서 그 라벨을 뗀다) */
  onRemove?: (name: string) => void;
}

/** 본문 헤더의 라벨 칩. 라벨 색은 목록 행·폴더 패널과 같은 `labelColorVar`를 쓴다. */
export function LabelChips({ labels, onRemove }: Props) {
  return (
    <>
      {labels.map((l) => (
        <span key={l.name} className={styles.chip}>
          <span className={styles.dot} style={{ background: labelColorVar(l.name) }} />
          {l.name}
          {onRemove && (
            <button
              type="button"
              className={styles.remove}
              aria-label={`${l.name} 라벨 떼기`}
              title="라벨 떼기"
              onClick={() => onRemove(l.name)}
            >
              <X size={12} strokeWidth={2} aria-hidden />
            </button>
          )}
        </span>
      ))}
    </>
  );
}
