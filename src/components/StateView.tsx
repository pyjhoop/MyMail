import { CloudOff, Inbox, MailOpen, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./StateView.module.css";

interface Props {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: "default" | "danger";
}

export function StateView({ icon: Icon, title, description, action, tone = "default" }: Props) {
  return (
    <div className={`${styles.state} ${tone === "danger" ? styles.danger : ""}`} role="status">
      <Icon size={32} strokeWidth={1.5} aria-hidden />
      <div className={styles.title}>{title}</div>
      {description && <div className={styles.desc}>{description}</div>}
      {action}
    </div>
  );
}

export const EmptyFolder = () => (
  <StateView icon={Inbox} title="빈 폴더" description="이 폴더에는 메일이 없어요." />
);

export const NoMailSelected = () => (
  <StateView
    icon={MailOpen}
    title="메일을 선택하세요"
    description="왼쪽 목록에서 읽을 메일을 고르면 여기에 보여요."
  />
);

export const OfflineState = ({ onRetry }: { onRetry: () => void }) => (
  <StateView
    icon={CloudOff}
    title="오프라인"
    description="인터넷에 연결되어 있지 않아요."
    action={
      <button type="button" className={styles.button} onClick={onRetry}>
        다시 연결
      </button>
    }
  />
);

export const AuthErrorState = ({ onRetry }: { onRetry: () => void }) => (
  <StateView
    icon={TriangleAlert}
    tone="danger"
    title="앱 비밀번호를 다시 입력해 주세요"
    description="계정 인증에 실패했어요."
    action={
      <button type="button" className={styles.button} onClick={onRetry}>
        다시 연결
      </button>
    }
  />
);

export const LoadErrorState = ({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <StateView
    icon={TriangleAlert}
    tone="danger"
    title="메일을 불러오지 못했어요"
    description={message}
    action={
      <button type="button" className={styles.button} onClick={onRetry}>
        다시 시도
      </button>
    }
  />
);

/** 목록 로딩 스켈레톤 */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className={styles.skeleton} role="status" aria-label="불러오는 중">
      {Array.from({ length: rows }, (_, i) => (
        <div className={styles.skelRow} key={i}>
          <span className={`${styles.bar} ${styles.w60}`} />
          <span className={`${styles.bar} ${styles.w90}`} />
          <span className={`${styles.bar} ${styles.w75}`} />
        </div>
      ))}
    </div>
  );
}

export function ReaderSkeleton(): ReactNode {
  return (
    <div className={styles.readerSkeleton} role="status" aria-label="불러오는 중">
      <span className={`${styles.bar} ${styles.title20}`} />
      <span className={`${styles.bar} ${styles.w40}`} />
      <span className={`${styles.bar} ${styles.w90}`} />
      <span className={`${styles.bar} ${styles.w75}`} />
      <span className={`${styles.bar} ${styles.w60}`} />
    </div>
  );
}
