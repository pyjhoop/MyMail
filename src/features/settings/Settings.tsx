import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { getAutostart, setAutostart, setSignature, toLoadError, type Account } from "../../lib/ipc";
import { SHORTCUTS } from "../shell/shortcuts";
import type { ThemePreference } from "../shell/useSystemTheme";
import styles from "./Settings.module.css";

const TABS = ["일반", "계정", "모양", "단축키"] as const;
type Tab = (typeof TABS)[number];

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "시스템 설정 따라가기" },
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
];

interface Props {
  accounts: Account[];
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onSignatureSaved: (accountId: string, signature: string) => void;
  onClose: () => void;
}

export function Settings({ accounts, theme, onThemeChange, onSignatureSaved, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("일반");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <main className={styles.settings} aria-label="설정">
      <nav className={styles.nav}>
        <button type="button" className={`ib ${styles.back}`} onClick={onClose}>
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
          메일로 돌아가기
          <span className={styles.key}>Esc</span>
        </button>
        <h1 className={styles.heading}>설정</h1>
        <div role="tablist" aria-orientation="vertical" className={styles.tabs}>
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className={`ib ${styles.tab}`}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </nav>
      <section className={styles.panel} role="tabpanel" aria-label={tab}>
        {tab === "일반" && <General />}
        {tab === "계정" && <Accounts accounts={accounts} onSignatureSaved={onSignatureSaved} />}
        {tab === "모양" && <Appearance theme={theme} onThemeChange={onThemeChange} />}
        {tab === "단축키" && <Shortcuts />}
      </section>
    </main>
  );
}

function General() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    getAutostart()
      .then((v) => {
        if (!cancelled) setEnabled(v);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(toLoadError(e).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (next: boolean) => {
    setError(undefined);
    try {
      await setAutostart(next);
      setEnabled(next);
    } catch (e) {
      setError(toLoadError(e).message);
    }
  };

  return (
    <>
      <h2 className={styles.title}>일반</h2>
      <label className={styles.row}>
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled === null}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>
          Windows 시작 시 실행
          <span className={styles.hint}>켜면 로그인할 때 창 없이 트레이로 시작해요.</span>
        </span>
      </label>
      <p className={styles.hint}>창을 닫으면 앱은 종료되지 않고 트레이에 남아요.</p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </>
  );
}

function Accounts({
  accounts,
  onSignatureSaved,
}: {
  accounts: Account[];
  onSignatureSaved: (accountId: string, signature: string) => void;
}) {
  if (accounts.length === 0) {
    return (
      <>
        <h2 className={styles.title}>계정</h2>
        <p className={styles.hint}>추가된 계정이 없어요.</p>
      </>
    );
  }
  return (
    <>
      <h2 className={styles.title}>계정</h2>
      {accounts.map((a) => (
        <AccountCard key={a.id} account={a} onSaved={onSignatureSaved} />
      ))}
    </>
  );
}

function AccountCard({
  account,
  onSaved,
}: {
  account: Account;
  onSaved: (accountId: string, signature: string) => void;
}) {
  const [text, setText] = useState(account.signature);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const dirty = text.trimEnd() !== account.signature;

  const save = async () => {
    setState("saving");
    try {
      await setSignature(account.id, text);
      onSaved(account.id, text.trimEnd());
      setState("saved");
    } catch {
      setState("error");
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span
          className={styles.avatar}
          style={{ background: `var(--account-${account.colorIndex})` }}
          aria-hidden
        >
          {account.initial}
        </span>
        <span>
          <span className={styles.name}>{account.name}</span>
          <span className={styles.hint}>
            {account.email} · {account.provider === "gmail" ? "Gmail" : "네이버"}
          </span>
        </span>
      </div>
      <label className={styles.label} htmlFor={`sig-${account.id}`}>
        서명
      </label>
      <textarea
        id={`sig-${account.id}`}
        className={styles.textarea}
        rows={4}
        value={text}
        placeholder="새 메일과 답장 끝에 넣을 서명"
        onChange={(e) => {
          setText(e.target.value);
          setState("idle");
        }}
      />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={!dirty || state === "saving"}
          onClick={() => void save()}
        >
          {state === "saving" ? "저장 중…" : "서명 저장"}
        </button>
        {state === "saved" && !dirty && <span className={styles.hint}>저장했어요.</span>}
        {state === "error" && (
          <span role="alert" className={styles.error}>
            서명을 저장하지 못했어요.
          </span>
        )}
      </div>
    </div>
  );
}

function Appearance({
  theme,
  onThemeChange,
}: {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}) {
  return (
    <>
      <h2 className={styles.title}>모양</h2>
      <div role="radiogroup" aria-label="테마" className={styles.group}>
        {THEMES.map((t) => (
          <label key={t.value} className={styles.row}>
            <input
              type="radio"
              name="theme"
              checked={theme === t.value}
              onChange={() => onThemeChange(t.value)}
            />
            <span>{t.label}</span>
          </label>
        ))}
      </div>
    </>
  );
}

function Shortcuts() {
  return (
    <>
      <h2 className={styles.title}>단축키</h2>
      <p className={styles.hint}>입력칸에 글자를 쓰는 중에는 한 글자 단축키가 동작하지 않아요.</p>
      <dl className={styles.shortcuts}>
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className={styles.shortcut}>
            <dt>
              <kbd className={styles.key}>{s.keys}</kbd>
            </dt>
            <dd>{s.label}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
