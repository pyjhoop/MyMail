import { Mail, Minus, Search, Settings, Square, X, CloudCheck } from "lucide-react";
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "../lib/window";
import styles from "./TitleBar.module.css";

interface Props {
  syncLabel: string;
  /** 0~1. 있으면 제목 표시줄 아래에 진행률 막대를 보여 준다 */
  syncProgress?: number;
  onOpenSettings: () => void;
}

export function TitleBar({ syncLabel, syncProgress, onOpenSettings }: Props) {
  return (
    <header className={styles.bar} data-tauri-drag-region>
      <div className={styles.brand} data-tauri-drag-region>
        <span className={styles.logo}>
          <Mail size={14} strokeWidth={2.25} aria-hidden />
        </span>
        <span className={styles.name}>MyMail</span>
      </div>
      <label className={styles.search}>
        <Search size={16} strokeWidth={2} aria-hidden />
        <input type="search" placeholder="메일 검색" aria-label="메일 검색" />
      </label>
      <div className={styles.right} data-tauri-drag-region>
        <span className={styles.sync}>
          <CloudCheck size={16} strokeWidth={2} aria-hidden />
          {syncLabel}
        </span>
        <button
          type="button"
          className={`ib ${styles.settings}`}
          aria-label="설정"
          onClick={onOpenSettings}
        >
          <Settings size={18} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          className={`ib ${styles.win}`}
          aria-label="최소화"
          onClick={minimizeWindow}
        >
          <Minus size={16} strokeWidth={1.25} aria-hidden />
        </button>
        <button
          type="button"
          className={`ib ${styles.win}`}
          aria-label="최대화"
          onClick={toggleMaximizeWindow}
        >
          <Square size={14} strokeWidth={1.25} aria-hidden />
        </button>
        <button
          type="button"
          className={`ib ${styles.win} ${styles.close}`}
          aria-label="닫기"
          onClick={closeWindow}
        >
          <X size={16} strokeWidth={1.25} aria-hidden />
        </button>
      </div>
      {syncProgress !== undefined && (
        <div
          className={styles.progress}
          role="progressbar"
          aria-label="메일 가져오기 진행률"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(syncProgress * 100)}
        >
          <div className={styles.progressFill} style={{ width: `${syncProgress * 100}%` }} />
        </div>
      )}
    </header>
  );
}
