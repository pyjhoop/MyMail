import { Plus, Tag } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  addLabel,
  createLabel,
  listFolders,
  removeLabel,
  supportsLabels,
  toLoadError,
  type Folder,
} from "../../lib/ipc";
import { labelColorVar, labelPaths } from "../../lib/labels";
import styles from "./LabelButton.module.css";

/** 라벨을 고를 때 필요한 메일 정보: 메일 id와 붙어 있는 라벨의 전체 이름 */
export interface LabelMail {
  id: string;
  labels: string[];
}

/** 라벨을 붙이거나 뗀 결과. 화면이 목록·본문을 맞추고 "실행 취소"를 만드는 데 쓴다 */
export interface LabelChange {
  /** 실제로 바뀐 메일 */
  ids: string[];
  label: string;
  added: boolean;
}

interface Props {
  accountId: string;
  /** 라벨을 바꿀 메일들(모두 같은 계정) */
  mails: LabelMail[];
  /** 이 계정의 폴더 목록. 그중 라벨만 고를 수 있다. 없으면 팝오버를 열 때 읽는다 */
  folders?: Folder[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (change: LabelChange) => void;
  onError: (message: string) => void;
  /** 목록 머리글처럼 좁은 곳에서 작게 그리고 오른쪽 끝에 맞춘다 */
  compact?: boolean;
}

type Check = "all" | "some" | "none";

/**
 * "라벨" 버튼과 팝오버. 라벨을 검색하고, 체크박스로 붙이고 떼고(여러 메일이면 일부만 붙은 라벨은 중간 상태),
 * 맨 아래에서 입력한 이름으로 새 라벨을 만들어 바로 붙인다. 라벨이 없는 계정에서는 아무것도 그리지 않는다.
 */
export function LabelButton({
  accountId,
  mails,
  folders,
  open,
  onOpenChange,
  onChanged,
  onError,
  compact = false,
}: Props) {
  // 어느 계정의 답인지 함께 들고 있어, 계정이 바뀐 직후에 앞 계정의 답이 보이지 않게 한다.
  const [support, setSupport] = useState<{ accountId: string; ok: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Folder[]>([]);
  const [fetched, setFetched] = useState<{ accountId: string; folders: Folder[] } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    supportsLabels(accountId)
      .then((ok) => !cancelled && setSupport({ accountId, ok }))
      .catch(() => !cancelled && setSupport({ accountId, ok: false }));
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  const supported = support?.accountId === accountId && support.ok;

  // 지원하지 않는 계정에서 단축키로 열린 팝오버는 닫아 둔다(다음 메일에서 갑자기 열리지 않게).
  useEffect(() => {
    if (open && support?.accountId === accountId && !support.ok) onOpenChange(false);
  }, [open, support, accountId, onOpenChange]);

  const close = (restoreFocus: boolean) => {
    onOpenChange(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 폴더 목록을 받지 못했으면(통합 보기에서 고른 메일 등) 열 때 이 계정의 목록을 읽는다.
  useEffect(() => {
    if (!open || folders) return;
    let cancelled = false;
    listFolders(accountId)
      .then((result) => !cancelled && setFetched({ accountId, folders: result }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, folders, accountId]);

  const labelFolders = useMemo(() => {
    const source = folders ?? (fetched?.accountId === accountId ? fetched.folders : []);
    const own = source.filter((f) => f.kind === "label");
    const extra = created.filter((c) => !own.some((f) => f.id === c.id));
    return [...own, ...extra];
  }, [folders, fetched, accountId, created]);
  const options = useMemo(() => {
    const paths = labelPaths(labelFolders);
    return labelFolders.map((f) => ({
      id: f.id,
      name: f.path ?? paths.get(f.id) ?? f.name,
    }));
  }, [labelFolders]);

  const needle = query.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.name.toLowerCase().includes(needle)) : options;
  const exists = options.some((o) => o.name.toLowerCase() === needle);

  const stateOf = (name: string): Check => {
    const n = mails.filter((m) => m.labels.includes(name)).length;
    return n === 0 ? "none" : n === mails.length ? "all" : "some";
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      onError(`라벨을 바꾸지 못했어요. ${toLoadError(e).message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string) =>
    run(async () => {
      const add = stateOf(name) !== "all";
      const ids = mails.filter((m) => m.labels.includes(name) !== add).map((m) => m.id);
      if (ids.length === 0) return;
      await (add ? addLabel : removeLabel)(ids, name);
      onChanged({ ids, label: name, added: add });
    });

  const create = () =>
    run(async () => {
      const folder = await createLabel(accountId, query);
      const name = folder.path ?? folder.name;
      setCreated((prev) => [...prev, folder]);
      const ids = mails.filter((m) => !m.labels.includes(name)).map((m) => m.id);
      if (ids.length > 0) {
        await addLabel(ids, name);
        onChanged({ ids, label: name, added: true });
      }
      setQuery("");
    });

  if (!supported) return null;
  const disabled = mails.length === 0;

  return (
    <div className={`${styles.root} ${compact ? styles.compact : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`ib ${styles.trigger}`}
        aria-label="라벨"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="라벨 (L)"
        disabled={disabled}
        onClick={() => (open ? close(false) : onOpenChange(true))}
      >
        <Tag size={compact ? 16 : 20} strokeWidth={1.75} aria-hidden />
      </button>
      {open && !disabled && (
        <div
          className={styles.popover}
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close(true);
            }
          }}
        >
          <div id={titleId} className={styles.title}>
            라벨 {mails.length > 1 ? `· 메일 ${mails.length}통` : ""}
          </div>
          <input
            ref={input}
            type="search"
            className={styles.search}
            aria-label="라벨 검색"
            placeholder="라벨 검색 또는 새 이름"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && needle && !exists && !busy) {
                e.preventDefault();
                void create();
              }
            }}
          />
          <div className={styles.list} role="group" aria-label="라벨 목록">
            {shown.length === 0 && (
              <div className={styles.empty}>
                {options.length === 0 ? "라벨이 없어요" : "맞는 라벨이 없어요"}
              </div>
            )}
            {shown.map((o) => {
              const state = stateOf(o.name);
              return (
                <label key={o.id} className={styles.row}>
                  <input
                    type="checkbox"
                    checked={state === "all"}
                    aria-checked={state === "some" ? "mixed" : state === "all"}
                    ref={(el) => {
                      if (el) el.indeterminate = state === "some";
                    }}
                    disabled={busy}
                    onChange={() => void toggle(o.name)}
                  />
                  <span className={styles.dot} style={{ background: labelColorVar(o.name) }} />
                  <span className={styles.name}>{o.name}</span>
                </label>
              );
            })}
          </div>
          <button
            type="button"
            className={styles.create}
            disabled={busy || !needle || exists}
            title={!needle ? "위 입력창에 새 라벨 이름을 적어 주세요" : undefined}
            onClick={() => void create()}
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden />
            {needle && !exists ? `"${query.trim()}" 새 라벨 만들기` : "새 라벨 만들기"}
          </button>
        </div>
      )}
    </div>
  );
}
