import type { RefObject } from "react";
import { Mail, Minus, Settings, Square, X, CloudCheck } from "lucide-react";
import { SearchBox } from "../features/search/SearchBox";
import type { Account } from "../lib/ipc";
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "../lib/window";
import styles from "./TitleBar.module.css";

interface Props {
  syncLabel: string;
  /** 0~1. 있으면 제목 표시줄 아래에 진행률 막대를 보여 준다 */
  syncProgress?: number;
  onOpenSettings: () => void;
  /** 검색창 입력값 (제어 컴포넌트). Esc로 지운다. */
  search: string;
  onSearchChange: (value: string) => void;
  /** 단축키(/)로 검색창에 포커스를 줄 때 쓴다 */
  searchInputRef?: RefObject<HTMLInputElement | null>;
  /** Enter·추천 선택으로 바로 검색할 때(입력 멈춤을 기다리지 않음) */
  onSearchSubmit?: (value: string) => void;
  /** 검색 범위 표시 ("모든 계정" 또는 계정 이름) */
  searchScope?: string;
  /** 보낸사람 추천을 가져올 계정. null이면 모든 계정 */
  searchAccountId?: string | null;
  accounts?: readonly Account[];
}

export function TitleBar({
  syncLabel,
  syncProgress,
  onOpenSettings,
  search,
  onSearchChange,
  searchInputRef,
  onSearchSubmit,
  searchScope = "모든 계정",
  searchAccountId = null,
  accounts = [],
}: Props) {
  return (
    <header className={styles.bar} data-tauri-drag-region>
      <div className={styles.brand} data-tauri-drag-region>
        <span className={styles.logo}>
          <Mail size={14} strokeWidth={2.25} aria-hidden />
        </span>
        <span className={styles.name}>MyMail</span>
      </div>
      <SearchBox
        value={search}
        onChange={onSearchChange}
        onSubmit={onSearchSubmit ?? onSearchChange}
        inputRef={searchInputRef}
        scopeLabel={searchScope}
        accountId={searchAccountId}
        accounts={accounts}
      />
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
