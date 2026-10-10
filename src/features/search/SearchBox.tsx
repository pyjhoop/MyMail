import { Search, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { suggestSenders, type Account, type SenderSuggestion } from "../../lib/ipc";
import styles from "./SearchBox.module.css";
import { SearchSuggest, type RecentOption, type SenderOption } from "./SearchSuggest";
import { addRecent, loadRecent, removeRecent } from "./recent";
import { splitOperators } from "./query";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Enter나 추천 항목 선택. 입력이 멈추길 기다리지 않고 바로 검색한다. */
  onSubmit: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** 검색 범위 표시 ("모든 계정" 또는 계정 이름) */
  scopeLabel: string;
  /** 보낸사람 추천을 가져올 계정. null이면 모든 계정 */
  accountId: string | null;
  accounts: readonly Account[];
}

const MAX_SENDERS = 3;

/** 입력 끝의 아직 다 안 쓴 단어(보낸사람 추천의 검색어). from:은 떼고 본다. */
function partialToken(value: string): string {
  if (value === "" || /\s$/.test(value)) return "";
  const last = value.split(/\s+/).pop() ?? "";
  if (last.toLowerCase().startsWith("from:")) return last.slice(5);
  return last.includes(":") ? "" : last;
}

/** 입력의 마지막 미완성 단어를 `from:주소`로 바꾼다. */
function withSender(value: string, email: string): string {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (
    partialToken(value) !== "" ||
    (tokens[tokens.length - 1] ?? "").toLowerCase().startsWith("from:")
  ) {
    tokens.pop();
  }
  return [...tokens, `from:${email}`].join(" ");
}

export function SearchBox({
  value,
  onChange,
  onSubmit,
  inputRef,
  scopeLabel,
  accountId,
  accounts,
}: Props) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const ownInput = useRef<HTMLInputElement>(null);
  const localInput = inputRef ?? ownInput;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [senders, setSenders] = useState<SenderSuggestion[]>([]);

  const prefix = partialToken(value);
  // 추천이 열려 있는 동안 입력에 맞는 보낸사람을 가져온다. 마지막 요청의 결과만 쓴다.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    suggestSenders(accountId, prefix, MAX_SENDERS)
      .then((list) => {
        if (!cancelled) setSenders(list);
      })
      .catch(() => {
        if (!cancelled) setSenders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, accountId, prefix]);

  const recentOptions: RecentOption[] = useMemo(() => {
    const needle = value.trim().toLowerCase();
    return recent
      .filter((r) => needle === "" || r.toLowerCase().includes(needle))
      .map((query) => ({ query, ...splitOperators(query) }));
  }, [recent, value]);
  const senderOptions: SenderOption[] = useMemo(
    () =>
      senders.map((s) => ({
        ...s,
        colorIndex: accounts.find((a) => a.id === s.accountId)?.colorIndex,
      })),
    [senders, accounts],
  );
  const total = recentOptions.length + senderOptions.length;

  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const submit = (query: string) => {
    const q = query.trim();
    if (q !== "") setRecent(addRecent(q));
    onChange(q);
    onSubmit(q);
    close();
  };
  const pickRecent = (query: string) => submit(query);
  const pickSender = (s: SenderOption) => submit(withSender(value, s.email));
  const insertTip = (tip: string) => {
    const base = value.trim();
    onChange(base === "" ? tip : `${base} ${tip}`);
    setActive(-1);
    localInput.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (!open) {
          setOpen(true);
          break;
        }
        if (total === 0) break;
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i < 0 ? (step === 1 ? 0 : total - 1) : (i + step + total) % total));
        break;
      }
      case "Enter": {
        if (open && active >= 0 && active < total) {
          e.preventDefault();
          if (active < recentOptions.length) pickRecent(recentOptions[active].query);
          else pickSender(senderOptions[active - recentOptions.length]);
        } else {
          submit(value);
        }
        break;
      }
      case "Tab": {
        // 보낸사람 항목에서 Tab: 검색하지 않고 from: 필터로 바꿔 이어서 쓰게 한다.
        const s =
          active >= recentOptions.length ? senderOptions[active - recentOptions.length] : null;
        if (open && s) {
          e.preventDefault();
          onChange(`${withSender(value, s.email)} `);
          setActive(-1);
        }
        break;
      }
      case "Escape":
        if (open) {
          // 추천만 닫는다. 한 번 더 누르면 입력을 지운다.
          e.preventDefault();
          close();
        } else {
          onChange("");
        }
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) close();
      }}
    >
      {open && <div className={styles.scrim} aria-hidden onMouseDown={close} />}
      <label className={styles.search}>
        <Search size={16} strokeWidth={2} aria-hidden />
        <input
          ref={localInput}
          type="search"
          placeholder="메일 검색"
          aria-label="메일 검색"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && active >= 0 ? `${listId}-opt-${active}` : undefined}
          autoComplete="off"
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange(e.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {value !== "" && (
          <button
            type="button"
            className={`ib ${styles.clear}`}
            aria-label="검색 지우기"
            onClick={() => {
              onChange("");
              localInput.current?.focus();
            }}
          >
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
        )}
        <span className={styles.scope}>{scopeLabel}</span>
      </label>
      {open && (
        <SearchSuggest
          id={listId}
          recent={recentOptions}
          senders={senderOptions}
          activeIndex={active}
          onPickRecent={pickRecent}
          onRemoveRecent={(q) => setRecent(removeRecent(q))}
          onPickSender={pickSender}
          onPickTip={insertTip}
          onHover={setActive}
        />
      )}
    </div>
  );
}
