import { ExternalLink, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  addAccount,
  toLoadError,
  type Account,
  type LoadError,
  type Provider,
} from "../../lib/ipc";
import styles from "./AddAccountDialog.module.css";

interface Props {
  onClose: () => void;
  onAdded: (account: Account) => void;
}

interface ProviderCopy {
  name: string;
  domain: string;
  subtitle: string;
  idLabel: string;
  passwordLabel: string;
  helpUrl: string;
  steps: string[];
}

const PROVIDERS: Record<Provider, ProviderCopy> = {
  naver: {
    name: "네이버",
    domain: "naver.com",
    subtitle: "네이버 메일에 IMAP으로 연결해요.",
    idLabel: "아이디",
    passwordLabel: "비밀번호 또는 애플리케이션 비밀번호",
    helpUrl: "https://help.naver.com/service/5640/contents/1070",
    steps: [
      "네이버 메일 › 환경설정 › POP3/IMAP 설정에서 IMAP 사용 켜기를 해 주세요.",
      "2단계 인증을 사용 중이면 네이버 보안 설정에서 애플리케이션 비밀번호를 만들어 위에 입력하세요.",
    ],
  },
  gmail: {
    name: "Gmail",
    domain: "gmail.com",
    subtitle: "Gmail에 IMAP으로 연결해요. 개인 Google 계정만 지원해요.",
    idLabel: "Gmail 주소",
    passwordLabel: "앱 비밀번호",
    helpUrl: "https://support.google.com/accounts/answer/185833",
    steps: [
      "Google 계정 › 보안에서 2단계 인증 켜기를 먼저 해 주세요.",
      "같은 화면에서 앱 비밀번호 16자리를 만들어 위에 입력하세요. 평소 쓰는 비밀번호로는 로그인되지 않아요.",
    ],
  },
};

/** 아이디만 적으면 서비스 도메인을 붙인다 */
const fullEmail = (input: string, domain: string) => {
  const id = input.trim();
  return id.includes("@") ? id : `${id}@${domain}`;
};

const failureTitle = (e: LoadError) =>
  e.kind === "auth" ? "로그인하지 못했어요" : "연결하지 못했어요";

export function AddAccountDialog({ onClose, onAdded }: Props) {
  const titleId = useId();
  const idInput = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<Provider>("naver");
  const copy = PROVIDERS[provider];
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);

  useEffect(() => {
    idInput.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const canSubmit = id.trim() !== "" && password.trim() !== "" && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      onAdded(await addAccount({ provider, email: fullEmail(id, copy.domain), password }));
    } catch (err) {
      setError(toLoadError(err));
      setBusy(false);
    }
  };

  return (
    <div className={styles.scrim}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
      >
        <header className={styles.header}>
          <div>
            <h2 id={titleId} className={styles.title}>
              {copy.name} 계정 연결
            </h2>
            <p className={styles.subtitle}>{copy.subtitle}</p>
          </div>
          <button
            type="button"
            className={`ib ${styles.close}`}
            aria-label="닫기"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} strokeWidth={1.75} aria-hidden />
          </button>
        </header>

        <div className={styles.providers} role="radiogroup" aria-label="메일 서비스">
          {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
            <label key={p} className={styles.provider}>
              <input
                type="radio"
                name="provider"
                value={p}
                checked={provider === p}
                disabled={busy}
                onChange={() => {
                  setProvider(p);
                  setError(null);
                }}
              />
              <span>{PROVIDERS[p].name}</span>
            </label>
          ))}
        </div>

        {error && (
          <div className={styles.error} role="alert">
            <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />
            <div>
              <div className={styles.errorTitle}>{failureTitle(error)}</div>
              <div>{error.message}</div>
            </div>
          </div>
        )}

        <label className={styles.field}>
          <span className={styles.label}>{copy.idLabel}</span>
          <input
            ref={idInput}
            className={styles.input}
            value={id}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setId(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{copy.passwordLabel}</span>
          <input
            className={styles.input}
            type="password"
            value={password}
            autoComplete="off"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <div className={styles.notice}>
          <div className={styles.noticeTitle}>연결 전에 확인해 주세요</div>
          {copy.steps.map((step) => (
            <p key={step}>{step}</p>
          ))}
          <a href={copy.helpUrl} target="_blank" rel="noreferrer" className={styles.link}>
            설정 방법 자세히 보기
            <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
          </a>
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.secondary} disabled={busy} onClick={onClose}>
            취소
          </button>
          <button type="submit" className={styles.primary} disabled={!canSubmit}>
            {busy && (
              <LoaderCircle size={16} strokeWidth={1.75} className={styles.spin} aria-hidden />
            )}
            {busy ? "연결하는 중" : error ? "다시 시도" : "연결"}
          </button>
        </footer>
      </form>
    </div>
  );
}
