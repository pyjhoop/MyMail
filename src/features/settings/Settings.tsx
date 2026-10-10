import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  appVersion,
  checkUpdate,
  getAutostart,
  installUpdate,
  onUpdateProgress,
  setAutostart,
  toLoadError,
  type Account,
  type ResetScope,
  type SyncProgress,
  type UpdateInfo,
} from "../../lib/ipc";
import type { Density } from "../shell/useDensity";
import { SHORTCUTS } from "../shell/shortcuts";
import type { ThemePreference } from "../shell/useSystemTheme";
import { AccountsPanel } from "./AccountsPanel";
import { DataReset } from "./DataReset";
import styles from "./Settings.module.css";

const TABS = ["일반", "계정", "모양", "단축키"] as const;
type Tab = (typeof TABS)[number];

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "시스템 설정 따라가기" },
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
];

const DENSITIES: { value: Density; label: string; hint: string }[] = [
  { value: "comfortable", label: "기본", hint: "보낸사람·제목·미리보기를 3줄로 보여 줘요." },
  { value: "compact", label: "컴팩트", hint: "한 줄에 모두 담아 더 많은 메일을 한눈에 봐요." },
];

const NO_SYNCS: Record<string, SyncProgress> = {};
const NO_SYNCED_AT: Record<string, number> = {};

interface Props {
  accounts: Account[];
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  /** 목록 밀도(모양 탭). 기본 3줄 행 */
  density?: Density;
  onDensityChange?: (density: Density) => void;
  /** 계정별 마지막 동기화 진행 알림과 마지막 성공 시각(ms). 계정 카드 머리줄 상태에 쓴다 */
  syncs?: Record<string, SyncProgress>;
  syncedAt?: Record<string, number>;
  onAccountPatch: (accountId: string, patch: Partial<Account>) => void;
  onAccountsReorder: (ids: string[]) => void;
  onAccountRemoved: (accountId: string) => void;
  onAddAccount: () => void;
  onDataReset: (scope: ResetScope) => void;
  onClose: () => void;
}

export function Settings({
  accounts,
  theme,
  onThemeChange,
  density = "comfortable",
  onDensityChange = () => undefined,
  syncs = NO_SYNCS,
  syncedAt = NO_SYNCED_AT,
  onAccountPatch,
  onAccountsReorder,
  onAccountRemoved,
  onAddAccount,
  onDataReset,
  onClose,
}: Props) {
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
        {tab === "일반" && (
          <>
            <General />
            <Updates />
            <DataReset onDone={onDataReset} />
          </>
        )}
        {tab === "계정" && (
          <AccountsPanel
            accounts={accounts}
            syncs={syncs}
            syncedAt={syncedAt}
            onAccountPatch={onAccountPatch}
            onAccountsReorder={onAccountsReorder}
            onAccountRemoved={onAccountRemoved}
            onAddAccount={onAddAccount}
          />
        )}
        {tab === "모양" && (
          <Appearance
            theme={theme}
            onThemeChange={onThemeChange}
            density={density}
            onDensityChange={onDensityChange}
          />
        )}
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

function Updates() {
  const [version, setVersion] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "latest" | "found" | "installing">(
    "idle",
  );
  const [info, setInfo] = useState<UpdateInfo>();
  const [percent, setPercent] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    appVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {});
    const off = onUpdateProgress((p) => {
      if (p.total) setPercent(Math.min(100, Math.round((p.downloaded / p.total) * 100)));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const check = async () => {
    setError(undefined);
    setState("checking");
    try {
      const found = await checkUpdate();
      setInfo(found ?? undefined);
      setState(found ? "found" : "latest");
    } catch (e) {
      setError(toLoadError(e).message);
      setState("idle");
    }
  };

  const install = async () => {
    setError(undefined);
    setPercent(undefined);
    setState("installing");
    try {
      await installUpdate();
    } catch (e) {
      setError(toLoadError(e).message);
      setState("found");
    }
  };

  return (
    <>
      <h2 className={styles.title}>업데이트</h2>
      <p className={styles.hint}>
        현재 버전 {version || "…"} · 새 버전은 자동으로 확인해 설치해요(시작 직후와 6시간마다).
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={state === "checking" || state === "installing"}
          onClick={() => void check()}
        >
          {state === "checking" ? "확인 중…" : "업데이트 확인"}
        </button>
        {state === "latest" && <span className={styles.hint}>최신 버전이에요.</span>}
      </div>
      {state === "found" && info && (
        <div className={styles.card}>
          <span className={styles.name}>새 버전 {info.version}이 있어요.</span>
          {info.notes && <p className={styles.hint}>{info.notes}</p>}
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => void install()}>
              지금 업데이트
            </button>
          </div>
        </div>
      )}
      {state === "installing" && (
        <p role="status" className={styles.hint}>
          {percent === undefined ? "받는 중…" : `받는 중… ${percent}%`} 설치가 시작되면 앱이 잠시
          닫혔다가 다시 열려요.
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </>
  );
}

function Appearance({
  theme,
  onThemeChange,
  density,
  onDensityChange,
}: {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  density: Density;
  onDensityChange: (density: Density) => void;
}) {
  return (
    <>
      <h2 className={styles.title}>모양</h2>
      <h3 className={styles.subtitle}>밀도</h3>
      <div role="radiogroup" aria-label="목록 밀도" className={styles.group}>
        {DENSITIES.map((d) => (
          <label key={d.value} className={styles.row}>
            <input
              type="radio"
              name="density"
              checked={density === d.value}
              onChange={() => onDensityChange(d.value)}
            />
            <span>
              {d.label}
              <span className={styles.hint}>{d.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <h3 className={styles.subtitle}>테마</h3>
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
