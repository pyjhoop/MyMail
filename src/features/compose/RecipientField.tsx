import { X } from "lucide-react";
import { useEffect, useId, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { formatRecipient, parseRecipient, suggestAddresses, type Recipient } from "../../lib/ipc";
import { isValidAddress, splitAddresses } from "./compose";
import styles from "./RecipientField.module.css";

interface Props {
  label: string;
  /** 칩으로 확정된 주소들 (`이름 <주소>` 또는 `주소`) */
  value: string[];
  onChange: (next: string[]) => void;
  /** 아직 칩이 되지 않은 입력 중인 글자. 보내기 직전에 부모가 확정한다. */
  text: string;
  onTextChange: (text: string) => void;
  autoFocus?: boolean;
}

/** 자동완성을 요청하기 전에 기다리는 시간. 타이핑마다 DB를 읽지 않게 한다. */
const SUGGEST_DELAY_MS = 150;

const keyOf = (raw: string) => parseRecipient(raw).email.toLowerCase();

/** 받는사람 입력: 주소 칩 + 자동완성 목록. 쉼표·세미콜론·Enter·Tab·포커스 이동으로 칩이 된다. */
export function RecipientField({ label, value, onChange, text, onTextChange, autoFocus }: Props) {
  const inputId = useId();
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  /** Esc로 닫은 입력값. 글자가 바뀌면 다시 열린다. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [found, setFound] = useState<{ query: string; list: Recipient[] } | null>(null);

  const query = text.trim();

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      suggestAddresses(query)
        .then((list) => {
          if (!cancelled) setFound({ query, list });
        })
        .catch(() => undefined);
    }, SUGGEST_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const taken = new Set(value.map(keyOf));
  const suggestions =
    found?.query === query ? found.list.filter((s) => !taken.has(s.email.toLowerCase())) : [];
  const open = focused && query !== "" && dismissed !== query && suggestions.length > 0;
  const current = Math.min(active, suggestions.length - 1);

  const add = (raws: string[]) => {
    const next = [...value];
    const seen = new Set(value.map(keyOf));
    for (const raw of raws) {
      const key = keyOf(raw);
      if (key && !seen.has(key)) {
        seen.add(key);
        next.push(raw);
      }
    }
    onChange(next);
    onTextChange("");
    setActive(0);
  };

  const commitText = () => {
    if (query) add(splitAddresses(text));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 한글 조합 중의 Enter·쉼표는 글자 확정용이다.
    if (e.nativeEvent.isComposing) return;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (open) add([formatRecipient(suggestions[current])]);
      else commitText();
    } else if (e.key === "," || e.key === ";") {
      e.preventDefault();
      commitText();
    } else if (e.key === "Tab") {
      commitText();
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      setDismissed(query);
    } else if (e.key === "Backspace" && text === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (/[,;\n]/.test(pasted)) {
      e.preventDefault();
      add(splitAddresses(`${text}${pasted}`));
    }
  };

  return (
    <div className={styles.row}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <div className={styles.chips}>
        {value.map((raw) => {
          const { name, email } = parseRecipient(raw);
          const shown = name || email;
          const valid = isValidAddress(raw);
          return (
            <span
              key={raw}
              className={`${styles.chip} ${valid ? "" : styles.invalid}`}
              title={valid ? email : `올바르지 않은 주소: ${raw}`}
            >
              <span className={styles.avatar} aria-hidden>
                {shown.slice(0, 1)}
              </span>
              {shown}
              <button
                type="button"
                className={styles.remove}
                aria-label={`${shown} 삭제`}
                onClick={() => onChange(value.filter((v) => v !== raw))}
              >
                <X size={12} strokeWidth={2.25} aria-hidden />
              </button>
            </span>
          );
        })}
        <input
          id={inputId}
          className={styles.input}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${current}` : undefined}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            onTextChange(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commitText();
          }}
        />
      </div>
      {open && (
        <div id={listId} role="listbox" aria-label={`${label} 추천`} className={styles.list}>
          {suggestions.map((s, i) => (
            <div
              key={s.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              className={`${styles.option} ${i === current ? styles.activeOption : ""}`}
              // 클릭하면 입력창이 포커스를 잃어 칩으로 확정되는 일을 막는다.
              onMouseDown={(e) => {
                e.preventDefault();
                add([formatRecipient(s)]);
              }}
            >
              <span className={styles.optionAvatar} aria-hidden>
                {(s.name || s.email).slice(0, 1)}
              </span>
              <span className={styles.optionText}>
                <span className={styles.optionName}>{s.name || s.email}</span>
                {s.name && <span className={styles.optionEmail}>{s.email}</span>}
              </span>
            </div>
          ))}
          <div className={styles.hint}>
            <span>↑↓ 이동</span>
            <span>Enter 추가</span>
            <span>Esc 닫기</span>
          </div>
        </div>
      )}
    </div>
  );
}
