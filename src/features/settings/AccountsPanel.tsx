import { useEffect, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus } from "lucide-react";
import {
  removeAccount,
  reorderAccounts,
  setNotifySettings,
  setSignature,
  setSignReplies,
  toLoadError,
  updateAccount,
  type Account,
  type NotifyScope,
  type SyncProgress,
} from "../../lib/ipc";
import { syncStatus, type SyncStatus } from "../../lib/syncStatus";
import styles from "./AccountsPanel.module.css";

const COLOR_NAMES = ["파랑", "초록", "주황", "보라", "분홍", "청록", "황토", "빨강"];

const NOTIFY_SCOPES: [NotifyScope, string][] = [
  ["inbox", "받은편지함만"],
  ["all", "모든 폴더"],
  ["starred", "별표한 보낸사람만"],
];

export interface AccountsPanelProps {
  accounts: Account[];
  /** 계정별 마지막 동기화 진행 알림 */
  syncs: Record<string, SyncProgress>;
  /** 계정별 마지막 성공 시각(ms) */
  syncedAt: Record<string, number>;
  onAccountPatch: (accountId: string, patch: Partial<Account>) => void;
  onAccountsReorder: (ids: string[]) => void;
  onAccountRemoved: (accountId: string) => void;
  onAddAccount: () => void;
}

/** `ids`에서 `fromId`를 빼서 `index`(빼기 전 기준 삽입 위치) 앞에 넣는다. */
function moveId(ids: string[], fromId: string, index: number): string[] {
  const from = ids.indexOf(fromId);
  if (from < 0) return ids;
  const next = ids.filter((id) => id !== fromId);
  next.splice(index > from ? index - 1 : index, 0, fromId);
  return next;
}

/** 상태 문구의 "N분 전"을 갱신하기 위한 현재 시각(ms). 30초마다 바뀐다. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function AccountsPanel({
  accounts,
  syncs,
  syncedAt,
  onAccountPatch,
  onAccountsReorder,
  onAccountRemoved,
  onAddAccount,
}: AccountsPanelProps) {
  const [openId, setOpenId] = useState<string | undefined>(accounts[0]?.id);
  const [dragId, setDragId] = useState<string>();
  const [dropIndex, setDropIndex] = useState<number>();
  const [error, setError] = useState<string>();

  const reorder = async (ids: string[]) => {
    if (ids.join() === accounts.map((a) => a.id).join()) return;
    setError(undefined);
    try {
      await reorderAccounts(ids);
      onAccountsReorder(ids);
    } catch (e) {
      setError(toLoadError(e).message);
    }
  };

  const ids = accounts.map((a) => a.id);
  const endDrag = () => {
    setDragId(undefined);
    setDropIndex(undefined);
  };
  const overCard = (e: DragEvent<HTMLDivElement>, index: number) => {
    if (!dragId) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setDropIndex(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
  };
  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (dragId && dropIndex !== undefined) void reorder(moveId(ids, dragId, dropIndex));
    endDrag();
  };
  const onHandleKey = (e: KeyboardEvent, id: string, index: number) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const to = e.key === "ArrowUp" ? index - 1 : index + 2;
    if (to < 0 || to > ids.length) return;
    void reorder(moveId(ids, id, to));
  };

  const now = useNow();

  return (
    <div className={styles.panel}>
      <div className={styles.top}>
        <div className={styles.topText}>
          <h2 className={styles.title}>계정</h2>
          <p className={styles.sub}>왼쪽 손잡이를 끌어 계정 레일 순서를 바꿀 수 있어요.</p>
        </div>
        <button type="button" className={styles.add} onClick={onAddAccount}>
          <Plus size={16} strokeWidth={2} aria-hidden />
          계정 추가
        </button>
      </div>
      {accounts.length === 0 && <p className={styles.hint}>추가된 계정이 없어요.</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div onDrop={drop} onDragOver={(e) => dragId && e.preventDefault()}>
        {accounts.map((account, index) => (
          <div key={account.id} onDragOver={(e) => overCard(e, index)}>
            {dropIndex === index && dragId !== account.id && <DropMark />}
            <AccountCard
              account={account}
              status={syncStatus(syncs[account.id], syncedAt[account.id], now)}
              open={openId === account.id}
              dragging={dragId === account.id}
              onToggle={() => setOpenId(openId === account.id ? undefined : account.id)}
              onDragStart={() => setDragId(account.id)}
              onDragEnd={endDrag}
              onHandleKey={(e) => onHandleKey(e, account.id, index)}
              onPatch={(patch) => onAccountPatch(account.id, patch)}
              onRemoved={() => onAccountRemoved(account.id)}
            />
          </div>
        ))}
        {dropIndex === accounts.length && <DropMark />}
      </div>
    </div>
  );
}

function DropMark() {
  return (
    <div aria-hidden className={styles.dropMark}>
      <span className={styles.dropLine} />
      <span className={styles.dropDot} />
    </div>
  );
}

interface CardProps {
  account: Account;
  status: SyncStatus;
  open: boolean;
  dragging: boolean;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onHandleKey: (e: KeyboardEvent) => void;
  onPatch: (patch: Partial<Account>) => void;
  onRemoved: () => void;
}

function AccountCard({
  account,
  status,
  open,
  dragging,
  onToggle,
  onDragStart,
  onDragEnd,
  onHandleKey,
  onPatch,
  onRemoved,
}: CardProps) {
  const [name, setName] = useState(account.name);
  const [signature, setSig] = useState(account.signature);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (job: () => Promise<void>) => {
    setError(undefined);
    try {
      await job();
    } catch (e) {
      setError(toLoadError(e).message);
    }
  };

  const saveProfile = (nextName: string, colorIndex: number) =>
    run(async () => {
      await updateAccount(account.id, nextName, colorIndex);
      onPatch({ name: nextName, colorIndex, initial: Array.from(nextName)[0] ?? "" });
    });

  const commitName = () => {
    const next = name.trim();
    if (!next) {
      setName(account.name);
      return;
    }
    setName(next);
    if (next !== account.name) void saveProfile(next, account.colorIndex);
  };

  const commitSignature = () => {
    const next = signature.trimEnd();
    if (next === account.signature) return;
    void run(async () => {
      await setSignature(account.id, next);
      onPatch({ signature: next });
    });
  };

  const toggleSignReplies = (on: boolean) =>
    run(async () => {
      await setSignReplies(account.id, on);
      onPatch({ signReplies: on });
    });

  const saveNotify = (
    patch: Partial<Pick<Account, "notifyEnabled" | "notifyScope" | "notifySound" | "notifyBadge">>,
  ) =>
    run(async () => {
      await setNotifySettings(account.id, {
        notifyEnabled: account.notifyEnabled,
        notifyScope: account.notifyScope,
        notifySound: account.notifySound,
        notifyBadge: account.notifyBadge,
        ...patch,
      });
      onPatch(patch);
    });

  const remove = async () => {
    setBusy(true);
    await run(async () => {
      await removeAccount(account.id);
      onRemoved();
    });
    setBusy(false);
  };

  const color = `var(--account-${account.colorIndex})`;

  return (
    <section
      aria-label={`${account.name} 설정`}
      className={`${styles.card} ${open ? styles.cardOpen : ""} ${dragging ? styles.dragging : ""}`}
    >
      <div className={styles.head}>
        <button
          type="button"
          className={`ib ${styles.handle}`}
          aria-label="순서 바꾸기"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", account.id);
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          onKeyDown={onHandleKey}
        >
          <GripVertical size={16} aria-hidden />
        </button>
        <button
          type="button"
          className={`ib ${styles.headMain}`}
          aria-expanded={open}
          onClick={onToggle}
        >
          <span
            className={styles.avatar}
            style={{
              background: color,
              boxShadow: `0 0 0 2px var(--color-bg), 0 0 0 4px ${color}`,
            }}
            aria-hidden
          >
            {account.initial}
          </span>
          <span className={styles.who}>
            <span className={styles.name}>{account.name}</span>
            <span className={styles.email}>
              {account.email} · {account.provider === "gmail" ? "Gmail" : "네이버"}
            </span>
          </span>
          <span className={`${styles.status} ${styles[`status_${status.tone}`]}`} role="status">
            <span className={styles.statusDot} aria-hidden />
            {status.text}
          </span>
          {open ? (
            <ChevronUp size={16} strokeWidth={1.75} aria-hidden className={styles.chevron} />
          ) : (
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden className={styles.chevron} />
          )}
        </button>
      </div>
      {open && (
        <>
          <div className={styles.form}>
            <label className={styles.label} htmlFor={`dn-${account.id}`}>
              표시 이름
            </label>
            <input
              id={`dn-${account.id}`}
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />

            <span className={styles.label}>계정 색</span>
            <div role="group" aria-label="계정 색" className={styles.swatches}>
              {COLOR_NAMES.map((label, i) => {
                const index = i + 1;
                const selected = account.colorIndex === index;
                return (
                  <button
                    key={label}
                    type="button"
                    aria-label={label}
                    aria-pressed={selected}
                    className={styles.swatch}
                    style={{
                      background: `var(--account-${index})`,
                      boxShadow: selected
                        ? `0 0 0 2px var(--color-bg), 0 0 0 4px var(--account-${index})`
                        : "none",
                    }}
                    onClick={() => {
                      if (!selected) void saveProfile(account.name, index);
                    }}
                  />
                );
              })}
            </div>

            <label className={styles.label} htmlFor={`sig-${account.id}`}>
              서명
            </label>
            <div className={styles.sigBox}>
              <textarea
                id={`sig-${account.id}`}
                className={styles.textarea}
                rows={3}
                value={signature}
                placeholder="새 메일과 답장 끝에 넣을 서명"
                onChange={(e) => setSig(e.target.value)}
                onBlur={commitSignature}
              />
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={account.signReplies}
                  onChange={(e) => void toggleSignReplies(e.target.checked)}
                />
                답장·전달에도 서명 넣기
              </label>
            </div>

            <span className={styles.label} id={`notify-${account.id}`}>
              알림
            </span>
            <div className={styles.sigBox} role="group" aria-labelledby={`notify-${account.id}`}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={account.notifyEnabled}
                  onChange={(e) => void saveNotify({ notifyEnabled: e.target.checked })}
                />
                새 메일 알림
              </label>
              <div
                className={styles.radios}
                role="radiogroup"
                aria-label="알림 대상"
                aria-disabled={!account.notifyEnabled}
              >
                {NOTIFY_SCOPES.map(([scope, text]) => (
                  <label key={scope} className={styles.check}>
                    <input
                      type="radio"
                      name={`notify-scope-${account.id}`}
                      checked={account.notifyScope === scope}
                      disabled={!account.notifyEnabled}
                      onChange={() => void saveNotify({ notifyScope: scope })}
                    />
                    {text}
                  </label>
                ))}
              </div>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={account.notifySound}
                  disabled={!account.notifyEnabled}
                  onChange={(e) => void saveNotify({ notifySound: e.target.checked })}
                />
                알림 소리
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={account.notifyBadge}
                  onChange={(e) => void saveNotify({ notifyBadge: e.target.checked })}
                />
                작업 표시줄 아이콘에 안 읽은 수 표시
              </label>
            </div>
          </div>
          <div className={styles.foot}>
            {confirming ? (
              <>
                <span className={styles.confirmText}>
                  이 PC에 저장된 이 계정의 메일과 비밀번호를 지워요. 서버의 메일은 그대로예요.
                </span>
                <span className={styles.spacer} />
                <button
                  type="button"
                  className={styles.plain}
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  취소
                </button>
                <button
                  type="button"
                  className={styles.danger}
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {busy ? "제거 중…" : "제거"}
                </button>
              </>
            ) : (
              <>
                <button type="button" className={styles.danger} onClick={() => setConfirming(true)}>
                  계정 제거
                </button>
                <span className={styles.spacer} />
                {error ? (
                  <span role="alert" className={styles.errorText}>
                    {error}
                  </span>
                ) : (
                  <span className={styles.footNote}>변경 사항은 자동 저장돼요</span>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
