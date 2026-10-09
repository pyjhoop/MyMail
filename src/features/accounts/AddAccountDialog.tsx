import { Check, ExternalLink, Info, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  addAccount,
  onSyncProgress,
  toLoadError,
  type Account,
  type LoadError,
  type Provider,
  type SyncProgress,
} from "../../lib/ipc";
import styles from "./AddAccountDialog.module.css";

interface Props {
  onClose: () => void;
  /** 계정이 추가된 직후(마법사는 열려 있다). 닫는 것은 `onClose`가 맡는다. */
  onAdded: (account: Account) => void;
  /** 이미 있는 계정. 색 팔레트에서 쓰는 색을 표시하고 기본 색을 정하는 데 쓴다. */
  accounts?: Account[];
}

type Step = "credentials" | "style" | "sync";

/** 디자인(S-03)의 4단계 중 서비스 선택은 입력 화면에 합쳐져 있어 입력이 2단계다. */
const STEP_NUMBER: Record<Step, number> = { credentials: 2, style: 3, sync: 4 };
const STEP_COUNT = 4;
const COLOR_NAMES = ["파랑", "초록", "주황", "보라", "분홍", "청록", "황토", "빨강"];
const COLORS = COLOR_NAMES.map((_, i) => i + 1);

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

const count = (n: number) => n.toLocaleString("ko-KR");

export function AddAccountDialog({ onClose, onAdded, accounts = [] }: Props) {
  const titleId = useId();
  const idInput = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<Provider>("naver");
  const copy = PROVIDERS[provider];
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);
  const [step, setStep] = useState<Step>("credentials");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [colorIndex, setColorIndex] = useState(() => (accounts.length % 8) + 1);
  const [added, setAdded] = useState<Account | null>(null);
  // 계정 id는 add_account가 끝나야 알 수 있으므로, 처음부터 모든 계정의 진행 알림을 받아 두고 나중에 거른다.
  const [progresses, setProgresses] = useState<Record<string, SyncProgress>>({});

  useEffect(
    () =>
      onSyncProgress((p) => {
        setProgresses((prev) => ({ ...prev, [p.accountId]: p }));
      }),
    [],
  );

  useEffect(() => {
    if (step === "credentials") idInput.current?.focus();
  }, [step]);

  const email = fullEmail(id, copy.domain);
  const defaultName = email.split("@")[0] ?? "";
  const shownName = nameEdited ? name : defaultName;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const canNext = id.trim() !== "" && password.trim() !== "" && !busy;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const account = await addAccount({
        provider,
        email,
        password,
        name: shownName.trim() || undefined,
        colorIndex,
      });
      setAdded(account);
      setBusy(false);
      setStep("sync");
      onAdded(account);
    } catch (err) {
      setError(toLoadError(err));
      setBusy(false);
      setStep("credentials");
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (step === "credentials" && canNext) setStep("style");
    else if (step === "style") void connect();
  };

  if (step === "sync" && added) {
    return <SyncStep account={added} progress={progresses[added.id]} onClose={onClose} />;
  }

  return (
    <div className={styles.scrim}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
      >
        <StepIndicator step={step} onClose={onClose} disabled={busy} />
        <header className={styles.header}>
          <div>
            <h2 id={titleId} className={styles.title}>
              {step === "style" ? "계정을 알아보기 쉽게" : `${copy.name} 계정 연결`}
            </h2>
            <p className={styles.subtitle}>
              {step === "style" ? `${email} 로 연결해요.` : copy.subtitle}
            </p>
          </div>
        </header>
        {step === "credentials" && (
          <>
            <div className={styles.providers} role="radiogroup" aria-label="메일 서비스">
              {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
                <label key={p} className={styles.provider}>
                  <input
                    type="radio"
                    name="provider"
                    value={p}
                    checked={provider === p}
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
              {copy.steps.map((text) => (
                <p key={text}>{text}</p>
              ))}
              <a href={copy.helpUrl} target="_blank" rel="noreferrer" className={styles.link}>
                설정 방법 자세히 보기
                <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
              </a>
            </div>
          </>
        )}
        {step === "style" && (
          <>
            <label className={styles.field}>
              <span className={styles.label}>표시 이름</span>
              <input
                className={styles.input}
                value={shownName}
                disabled={busy}
                autoComplete="off"
                onChange={(e) => {
                  setName(e.target.value);
                  setNameEdited(true);
                }}
              />
            </label>
            <fieldset className={styles.colors}>
              <legend className={styles.label}>계정 색</legend>
              <div className={styles.swatches}>
                {COLORS.map((c) => {
                  const used = accounts.some((a) => a.colorIndex === c);
                  return (
                    <button
                      key={c}
                      type="button"
                      className={`${styles.swatch} ${used ? styles.swatchUsed : ""}`}
                      style={{ background: `var(--account-${c})` }}
                      aria-label={`${COLOR_NAMES[c - 1]}${used ? " (다른 계정이 사용 중)" : ""}`}
                      aria-pressed={colorIndex === c}
                      disabled={busy}
                      onClick={() => setColorIndex(c)}
                    >
                      {colorIndex === c && <Check size={16} strokeWidth={2.5} aria-hidden />}
                    </button>
                  );
                })}
              </div>
              <span className={styles.hint}>
                회색 테두리는 다른 계정이 쓰는 색이에요. 겹쳐도 선택할 수 있어요.
              </span>
            </fieldset>
            <div className={styles.preview}>
              <span
                className={styles.previewAvatar}
                style={{ background: `var(--account-${colorIndex})` }}
              >
                {(shownName.trim() || defaultName).slice(0, 1)}
              </span>
              <span className={styles.previewText}>
                <span
                  className={styles.previewBar}
                  style={{ background: `var(--account-${colorIndex})` }}
                />
                <span className={styles.previewName}>{shownName.trim() || defaultName}</span>
                <span className={styles.previewMail}>{email}</span>
              </span>
              <span className={styles.hint}>미리보기</span>
            </div>
          </>
        )}
        <footer className={styles.footer}>
          {step === "style" ? (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => setStep("credentials")}
            >
              이전
            </button>
          ) : (
            <button type="button" className={styles.secondary} onClick={onClose}>
              취소
            </button>
          )}
          <button
            type="submit"
            className={styles.primary}
            disabled={step === "credentials" ? !canNext : busy}
          >
            {busy && (
              <LoaderCircle size={16} strokeWidth={1.75} className={styles.spin} aria-hidden />
            )}
            {step === "credentials"
              ? error
                ? "다시 시도"
                : "다음"
              : busy
                ? "연결하는 중"
                : "연결"}
          </button>
        </footer>
      </form>
    </div>
  );
}
function StepIndicator({
  step,
  onClose,
  disabled,
}: {
  step: Step;
  onClose: () => void;
  disabled?: boolean;
}) {
  const n = STEP_NUMBER[step];
  return (
    <div className={styles.steps}>
      <span className={styles.stepText}>
        {n} / {STEP_COUNT}
      </span>
      <span className={styles.stepBars} aria-hidden>
        {Array.from({ length: STEP_COUNT }, (_, i) => (
          <span key={i} className={i < n ? styles.stepOn : styles.stepOff} />
        ))}
      </span>
      <span className={styles.grow} />
      <button
        type="button"
        className={`ib ${styles.close}`}
        aria-label="닫기"
        disabled={disabled}
        onClick={onClose}
      >
        <X size={20} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

function SyncStep({
  account,
  progress,
  onClose,
}: {
  account: Account;
  progress: SyncProgress | undefined;
  onClose: () => void;
}) {
  const titleId = useId();
  const failed = progress?.error != null;
  const finished = progress !== undefined && !failed && progress.done >= progress.total;
  const percent =
    progress && progress.total > 0 ? Math.floor((progress.done / progress.total) * 100) : 0;
  const title = failed
    ? "메일을 다 가져오지 못했어요"
    : finished
      ? "메일을 모두 가져왔어요"
      : "메일을 가져오고 있어요";

  return (
    <div className={styles.scrim}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <StepIndicator step="sync" onClose={onClose} />
        <header className={styles.header}>
          <div>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <p className={styles.subtitle}>
              받은편지함의 최신 메일은 이미 받았어요. 나머지는 최근 메일부터 가져와요.
            </p>
          </div>
        </header>

        {failed && (
          <div className={styles.error} role="alert">
            <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />
            <div>
              <div className={styles.errorTitle}>동기화가 중간에 멈췄어요</div>
              <div>{progress?.error} 이미 받은 메일은 그대로 있고, 나중에 이어서 받아요.</div>
            </div>
          </div>
        )}

        {progress === undefined ? (
          <div className={styles.checking} role="status">
            <LoaderCircle size={16} strokeWidth={1.75} className={styles.spin} aria-hidden />
            메일 목록을 확인하는 중…
          </div>
        ) : finished && progress.total === 0 ? (
          <div className={styles.checking} role="status">
            <Check size={16} strokeWidth={2} aria-hidden />더 가져올 메일이 없어요.
          </div>
        ) : (
          <div>
            <div className={styles.counts}>
              <span className={styles.big}>{count(progress.done)}</span>
              <span className={styles.total}>/ {count(progress.total)}통</span>
              <span className={styles.grow} />
              <span className={styles.hint}>{percent}%</span>
            </div>
            <div
              className={styles.bar}
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="전체 동기화 진행률"
            >
              <span
                className={styles.barFill}
                style={{
                  width: `${percent}%`,
                  background: `var(--account-${account.colorIndex})`,
                }}
              />
            </div>
          </div>
        )}

        {!finished && !failed && (
          <div className={`${styles.notice} ${styles.noticeRow}`}>
            <Info size={16} strokeWidth={1.75} aria-hidden />
            <span>
              이 창을 닫아도 동기화는 <b>백그라운드에서 계속돼요.</b> 진행 상황은 제목 표시줄에서 볼
              수 있어요.
            </span>
          </div>
        )}

        <footer className={styles.footer}>
          <button type="button" className={styles.primary} onClick={onClose}>
            {finished || failed ? "메일함 열기" : "백그라운드로 계속 받기"}
          </button>
        </footer>
      </div>
    </div>
  );
}
