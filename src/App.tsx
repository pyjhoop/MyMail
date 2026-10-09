import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ResizeHandle } from "./components/ResizeHandle";
import { TitleBar } from "./components/TitleBar";
import { AccountRail, type AccountSelection } from "./features/accounts/AccountRail";
import { AddAccountDialog } from "./features/accounts/AddAccountDialog";
import { Composer, type ComposeInit, type ComposeResult } from "./features/compose/Composer";
import { startDraft, type ComposeMode } from "./features/compose/compose";
import { Settings } from "./features/settings/Settings";
import { FolderPane } from "./features/folders/FolderPane";
import { MailList, type ListStatus } from "./features/mail/MailList";
import { Reader } from "./features/mail/Reader";
import { FOLDER, RAIL, usePanelWidths } from "./features/shell/usePanelWidths";
import { useShortcuts } from "./features/shell/shortcuts";
import {
  loadTheme,
  saveTheme,
  useTheme,
  type ThemePreference,
} from "./features/shell/useSystemTheme";
import {
  deleteMail,
  getDraft,
  getMail,
  isDraftId,
  listAccounts,
  listFolders,
  listMails,
  onSyncProgress,
  onTrayCompose,
  onWindowFocus,
  searchMails,
  setRead,
  syncNow,
  toLoadError,
  type Account,
  type Folder,
  type LoadError,
  type MailDetail,
  type MailSummary,
  type SyncProgress,
} from "./lib/ipc";
import styles from "./App.module.css";

const EMPTY_MAILS: MailSummary[] = [];
const EMPTY_FOLDERS: Folder[] = [];
const EMPTY_IDS: ReadonlySet<string> = new Set();
/** 방향키로 훑을 때 읽음 처리되지 않도록 본문을 연 뒤 이만큼 기다린다. */
const READ_DELAY_MS = 1000;
/** 검색어를 입력하는 동안 매 글자마다 검색하지 않도록 기다리는 시간. */
const SEARCH_DELAY_MS = 300;

function App() {
  const [theme, setTheme] = useState<ThemePreference>(loadTheme);
  useTheme(theme);
  const { widths, dragFolder, dragList, endDrag, resetFolder, resetList } = usePanelWidths();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selection, setSelection] = useState<AccountSelection>("all");
  const [selectedFolderId, setFolderId] = useState("");
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [foldersReloadKey, setFoldersReloadKey] = useState(0);
  const [mailId, setMailId] = useState<string | null>(null);
  const [syncs, setSyncs] = useState<Record<string, SyncProgress>>({});
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 확인 창이 지울 메일. 목록에서 체크한 메일이거나 단축키로 지우려는 열린 메일이다.
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const [search, setSearch] = useState("");
  // 입력이 잠깐 멈추면 검색한다. 비어 있으면 평소 목록으로 돌아간다.
  const [term, setTerm] = useState("");

  // 비동기 결과는 "어떤 요청의 결과인지"(key)와 함께 저장하고, 현재 요청과 같을 때만 ready로 본다.
  // effect 안에서 loading을 동기적으로 setState하지 않기 위한 구조.
  const [foldersResult, setFoldersResult] = useState<{ key: string; folders: Folder[] } | null>(
    null,
  );
  const [mailsResult, setMailsResult] = useState<{
    /** 어느 폴더의 목록인지. 새로고침(reloadKey)이 바뀌어도 같으면 이전 목록을 유지해 깜빡이지 않는다. */
    scope: string;
    mails: MailSummary[];
    error?: LoadError;
  } | null>(null);
  const [detailResult, setDetailResult] = useState<{ key: string; mail: MailDetail | null } | null>(
    null,
  );

  const folderPaneRef = useRef<HTMLDivElement>(null);
  const listPaneRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const account = selection === "all" ? null : (accounts.find((a) => a.id === selection) ?? null);

  const folders =
    selection !== "all" && foldersResult?.key === selection ? foldersResult.folders : EMPTY_FOLDERS;

  // 계정을 고르면 폴더 목록이 올 때까지 폴더를 모른다. 목록이 오면 받은편지함(kind)을 고른다.
  const folderId =
    selection === "all" || folders.some((f) => f.id === selectedFolderId)
      ? selectedFolderId
      : (folders.find((f) => f.kind === "inbox")?.id ?? "");
  const folderPending = selection !== "all" && folderId === "";

  const mailsScope = term ? `search|${selection}|${term}` : `${selection}|${folderId}`;
  const mailsReady = mailsResult?.scope === mailsScope;
  const status: ListStatus = !mailsReady ? "loading" : mailsResult.error ? "error" : "ready";
  const mails = mailsReady ? mailsResult.mails : EMPTY_MAILS;
  const error = mailsReady ? mailsResult.error : undefined;

  const detailLoading = mailId !== null && detailResult?.key !== mailId;
  const detail = mailId !== null && detailResult?.key === mailId ? detailResult.mail : null;

  useEffect(() => {
    listAccounts().then(setAccounts);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (selection === "all") return;
    let cancelled = false;
    listFolders(selection).then((result) => {
      if (!cancelled) setFoldersResult({ key: selection, folders: result });
    });
    return () => {
      cancelled = true;
    };
  }, [selection, foldersReloadKey]);

  useEffect(() => {
    if (folderPending && !term) return;
    let cancelled = false;
    const accountArg = selection === "all" ? null : selection;
    (term ? searchMails(accountArg, term) : listMails(accountArg, folderId))
      .then((result) => {
        if (!cancelled) setMailsResult({ scope: mailsScope, mails: result });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMailsResult({
          scope: mailsScope,
          mails: [],
          error: toLoadError(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selection, folderId, folderPending, term, mailsScope, reloadKey]);

  useEffect(() => {
    if (!mailId) return;
    let cancelled = false;
    getMail(mailId).then((d) => {
      if (!cancelled) setDetailResult({ key: mailId, mail: d });
    });
    return () => {
      cancelled = true;
    };
  }, [mailId]);

  // 본문이 열린 채 1초가 지나면 읽음 처리한다. 다른 메일을 고르거나 선택을 풀면 cleanup이 취소한다.
  const detailUnread = detail?.unread === true;
  useEffect(() => {
    if (!mailId || !detailUnread) return;
    const timer = setTimeout(() => {
      setRead(mailId, true)
        .then(() => {
          setDetailResult((prev) =>
            prev?.key === mailId && prev.mail
              ? { key: mailId, mail: { ...prev.mail, unread: false } }
              : prev,
          );
          // 목록은 다시 불러오지 않고(스켈레톤이 깜빡인다) 해당 행만 제자리에서 바꾼다.
          setMailsResult((prev) =>
            prev
              ? {
                  ...prev,
                  mails: prev.mails.map((m) => (m.id === mailId ? { ...m, unread: false } : m)),
                }
              : prev,
          );
          // 안 읽은 수는 이전 값을 유지한 채 새 값이 오면 바뀐다.
          setFoldersReloadKey((k) => k + 1);
          listAccounts().then(setAccounts);
        })
        .catch(() => undefined);
    }, READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [mailId, detailUnread]);

  // 백그라운드 동기화가 폴더를 하나 끝낼 때마다 목록과 안 읽은 수를 다시 읽는다.
  useEffect(
    () =>
      onSyncProgress((progress) => {
        setSyncs((prev) => ({ ...prev, [progress.accountId]: progress }));
        setReloadKey((k) => k + 1);
        setFoldersReloadKey((k) => k + 1);
        listAccounts().then(setAccounts);
      }),
    [],
  );

  const selectAccount = useCallback((next: AccountSelection) => {
    setSelection(next);
    setFolderId("");
    setMailId(null);
    setCheckedIds(EMPTY_IDS);
    setNotice(undefined);
  }, []);

  const selectFolder = useCallback((id: string, accountId: string) => {
    setSearch("");
    setTerm("");
    setSelection(accountId);
    setFolderId(id);
    setMailId(null);
    setCheckedIds(EMPTY_IDS);
    setNotice(undefined);
  }, []);

  // 동기화로 목록이 바뀌어 사라진 메일은 선택에서 뺀다.
  const checked = useMemo(
    () => new Set(mails.filter((m) => checkedIds.has(m.id)).map((m) => m.id)),
    [mails, checkedIds],
  );

  // 휴지통 안의 메일은 지우면 되돌릴 수 없어 확인을 받는다. 통합 보기는 받은편지함뿐이라 해당 없음.
  const inTrash = selection !== "all" && folders.find((f) => f.id === folderId)?.kind === "trash";

  const deleteIds = async (ids: string[]) => {
    setConfirmingDelete(false);
    if (ids.length === 0) return;
    setDeleting(true);
    setNotice(undefined);
    let failed = 0;
    // 같은 계정의 IMAP 연결을 번갈아 쓰지 않도록 하나씩 처리한다.
    for (const id of ids) {
      try {
        await deleteMail(id);
      } catch {
        failed += 1;
      }
    }
    setDeleting(false);
    setCheckedIds(EMPTY_IDS);
    if (mailId && ids.includes(mailId)) setMailId(null);
    if (failed > 0) setNotice(`메일 ${failed}통을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.`);
    setReloadKey((k) => k + 1);
    setFoldersReloadKey((k) => k + 1);
    listAccounts().then(setAccounts);
  };

  // 휴지통 안이거나 검색 결과면(휴지통 여부를 모른다) 확인을 받고, 아니면 바로 지운다.
  const requestDelete = (ids: string[]) => {
    if (ids.length === 0) return;
    setPendingIds(ids);
    if (inTrash || term) setConfirmingDelete(true);
    else void deleteIds(ids);
  };

  // 새 메일·답장·전달. 답장·전달은 열려 있는 메일이 속한 계정으로 보낸다.
  const startCompose = (mode: ComposeMode) => {
    const sender =
      mode === "new" ? (account ?? accounts[0]) : accounts.find((a) => a.id === detail?.accountId);
    if (!sender) return;
    const fields = startDraft({ mode, account: sender, mail: detail ?? undefined });
    setCompose({
      draft: { ...fields, status: "draft", error: null, attachments: [] },
      seed: { subject: fields.subject, body: fields.body },
      notice:
        mode === "forward" && detail && detail.attachments.length > 0
          ? "원본에 첨부된 파일은 전달되지 않아요. 필요하면 다시 첨부해 주세요."
          : undefined,
    });
  };

  const startComposeRef = useRef(startCompose);
  useEffect(() => {
    startComposeRef.current = startCompose;
  });
  useEffect(() => onTrayCompose(() => startComposeRef.current("new")), []);

  // 창이 다시 포커스를 얻으면(트레이에서 열 때 포함) 서버와 바로 맞춘다. 결과는 sync-progress 이벤트로 반영된다.
  const focusSyncRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    focusSyncRef.current = () => {
      syncNow(selection === "all" ? null : selection, folderId || undefined).catch(() => undefined);
    };
  });
  useEffect(() => onWindowFocus(() => focusSyncRef.current()), []);

  const openDraft = async (id: string) => {
    if (compose?.draft.id === id) return;
    const draft = await getDraft(id).catch(() => null);
    if (draft) setCompose({ draft, seed: { subject: "", body: "" } });
  };

  const selectMail = (id: string) => {
    if (isDraftId(id)) {
      void openDraft(id);
      return;
    }
    setCompose(null);
    setMailId(id);
  };

  const finishCompose = (result: ComposeResult) => {
    setCompose(null);
    if (result === "sent") setNotice("메일을 보냈어요.");
    setReloadKey((k) => k + 1);
    setFoldersReloadKey((k) => k + 1);
  };

  const index = mailId ? mails.findIndex((m) => m.id === mailId) : -1;
  const move = (delta: number) => {
    const next = mails[index + delta];
    if (next) setMailId(next.id);
  };

  // 작성기가 열려 있으면 메일 조작 단축키는 쉬고(작성 내용을 덮어쓰지 않게) 계정 전환만 쓴다.
  const composing = compose !== null;
  useShortcuts(
    {
      compose: () => !composing && startCompose("new"),
      reply: () => !composing && detail && startCompose("reply"),
      replyAll: () => !composing && detail && startCompose("replyAll"),
      forward: () => !composing && detail && startCompose("forward"),
      remove: () => !composing && mailId && requestDelete([mailId]),
      search: () => searchInputRef.current?.focus(),
      next: () => !composing && move(1),
      prev: () => !composing && move(-1),
      switchAccount: (n) => {
        if (n === 1) selectAccount("all");
        else if (accounts[n - 2]) selectAccount(accounts[n - 2].id);
      },
    },
    !settingsOpen && !confirmingDelete && !adding,
  );

  const title = useMemo(() => {
    if (term) return `검색: ${term}`;
    if (selection === "all") return "통합 받은편지함";
    return folders.find((f) => f.id === folderId)?.name ?? "받은편지함";
  }, [term, selection, folders, folderId]);

  const running = Object.values(syncs).filter((s) => s.error === null && s.done < s.total);
  const failed = Object.values(syncs).find((s) => s.error !== null);
  const syncDone = running.reduce((n, s) => n + s.done, 0);
  const syncTotal = running.reduce((n, s) => n + s.total, 0);
  const syncLabel =
    running.length > 0
      ? `메일 가져오는 중 ${syncDone}/${syncTotal}`
      : failed
        ? "일부 메일을 가져오지 못했어요"
        : "방금 동기화됨";

  const folderWidth = widths.folderCollapsed ? FOLDER.collapsed : widths.folder;
  const shellStyle = {
    "--folder-width": `${widths.folder}px`,
    "--list-width": `${widths.list}px`,
  } as CSSProperties;

  return (
    <div className={styles.app} style={shellStyle}>
      <TitleBar
        syncLabel={syncLabel}
        syncProgress={running.length > 0 ? syncDone / syncTotal : undefined}
        search={search}
        onSearchChange={setSearch}
        searchInputRef={searchInputRef}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen ? (
        <div className={styles.body}>
          <Settings
            accounts={accounts}
            theme={theme}
            onThemeChange={(next) => {
              setTheme(next);
              saveTheme(next);
            }}
            onSignatureSaved={(accountId, signature) =>
              setAccounts((prev) => prev.map((a) => (a.id === accountId ? { ...a, signature } : a)))
            }
            onClose={() => setSettingsOpen(false)}
          />
        </div>
      ) : (
        <div className={styles.body}>
          <AccountRail
            accounts={accounts}
            selected={selection}
            onSelect={selectAccount}
            onAddAccount={() => setAdding(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <div ref={folderPaneRef} className={styles.pane}>
            <FolderPane
              account={account}
              accounts={accounts}
              folders={folders}
              selectedId={folderId}
              collapsed={widths.folderCollapsed}
              onSelect={selectFolder}
              onCompose={() => startCompose("new")}
            />
          </div>
          <ResizeHandle
            label="폴더 패널 너비 조절"
            value={folderWidth}
            getOrigin={() => folderPaneRef.current?.getBoundingClientRect().left ?? RAIL}
            onDrag={(w) => dragFolder(w, window.innerWidth)}
            onEnd={endDrag}
            onReset={resetFolder}
          />
          <div ref={listPaneRef} className={styles.pane}>
            <MailList
              title={title}
              status={status}
              error={error}
              mails={mails}
              accounts={accounts}
              showAccount={selection === "all"}
              selectedId={compose ? compose.draft.id : mailId}
              onSelect={selectMail}
              checkedIds={checked}
              onCheckedChange={setCheckedIds}
              onDelete={() => requestDelete([...checked])}
              deleting={deleting}
              notice={notice}
              searching={term !== ""}
              onRefresh={() => setReloadKey((k) => k + 1)}
            />
          </div>
          <ResizeHandle
            label="메일 목록 너비 조절"
            value={widths.list}
            getOrigin={() => listPaneRef.current?.getBoundingClientRect().left ?? 0}
            onDrag={(w) => dragList(w, window.innerWidth)}
            onEnd={endDrag}
            onReset={resetList}
          />
          {compose ? (
            <Composer
              key={compose.draft.id}
              accounts={accounts}
              init={compose}
              onClose={finishCompose}
              onSignatureSaved={(accountId, signature) =>
                setAccounts((prev) =>
                  prev.map((a) => (a.id === accountId ? { ...a, signature } : a)),
                )
              }
            />
          ) : (
            <Reader
              mail={detail}
              loading={detailLoading}
              position={index >= 0 ? `${index + 1} / ${mails.length}` : undefined}
              onPrev={() => move(-1)}
              onNext={() => move(1)}
              onCompose={startCompose}
            />
          )}
        </div>
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={term ? "메일을 삭제할까요?" : "메일을 완전히 삭제할까요?"}
          message={
            term
              ? `선택한 메일 ${pendingIds.length}통을 삭제해요. 휴지통에 있던 메일은 완전히 지워지고 되돌릴 수 없어요.`
              : `선택한 메일 ${pendingIds.length}통이 휴지통에서 완전히 지워져요. 되돌릴 수 없어요.`
          }
          confirmLabel={term ? "삭제" : "완전히 삭제"}
          onConfirm={() => void deleteIds(pendingIds)}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      {adding && (
        <AddAccountDialog
          onClose={() => setAdding(false)}
          onAdded={(added) => {
            setAdding(false);
            setAccounts((prev) => [...prev, added]);
            selectAccount(added.id);
          }}
        />
      )}
    </div>
  );
}

export default App;
