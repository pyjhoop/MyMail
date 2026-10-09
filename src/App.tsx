import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ResizeHandle } from "./components/ResizeHandle";
import { TitleBar } from "./components/TitleBar";
import { AccountRail, type AccountSelection } from "./features/accounts/AccountRail";
import { AddAccountDialog } from "./features/accounts/AddAccountDialog";
import { FolderPane } from "./features/folders/FolderPane";
import { MailList, type ListStatus } from "./features/mail/MailList";
import { Reader } from "./features/mail/Reader";
import { FOLDER, RAIL, usePanelWidths } from "./features/shell/usePanelWidths";
import { useSystemTheme } from "./features/shell/useSystemTheme";
import {
  getMail,
  listAccounts,
  listFolders,
  listMails,
  onSyncProgress,
  setRead,
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
/** 방향키로 훑을 때 읽음 처리되지 않도록 본문을 연 뒤 이만큼 기다린다. */
const READ_DELAY_MS = 1000;

function App() {
  useSystemTheme();
  const { widths, dragFolder, dragList, endDrag, resetFolder, resetList } = usePanelWidths();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selection, setSelection] = useState<AccountSelection>("all");
  const [selectedFolderId, setFolderId] = useState("");
  const [adding, setAdding] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [foldersReloadKey, setFoldersReloadKey] = useState(0);
  const [mailId, setMailId] = useState<string | null>(null);
  const [syncs, setSyncs] = useState<Record<string, SyncProgress>>({});

  // 비동기 결과는 "어떤 요청의 결과인지"(key)와 함께 저장하고, 현재 요청과 같을 때만 ready로 본다.
  // effect 안에서 loading을 동기적으로 setState하지 않기 위한 구조.
  const [foldersResult, setFoldersResult] = useState<{ key: string; folders: Folder[] } | null>(
    null,
  );
  const [mailsResult, setMailsResult] = useState<{
    key: string;
    mails: MailSummary[];
    error?: LoadError;
  } | null>(null);
  const [detailResult, setDetailResult] = useState<{ key: string; mail: MailDetail | null } | null>(
    null,
  );

  const folderPaneRef = useRef<HTMLDivElement>(null);
  const listPaneRef = useRef<HTMLDivElement>(null);

  const account = selection === "all" ? null : (accounts.find((a) => a.id === selection) ?? null);

  const folders =
    selection !== "all" && foldersResult?.key === selection ? foldersResult.folders : EMPTY_FOLDERS;

  // 계정을 고르면 폴더 목록이 올 때까지 폴더를 모른다. 목록이 오면 받은편지함(kind)을 고른다.
  const folderId =
    selection === "all" || folders.some((f) => f.id === selectedFolderId)
      ? selectedFolderId
      : (folders.find((f) => f.kind === "inbox")?.id ?? "");
  const folderPending = selection !== "all" && folderId === "";

  const mailsKey = `${selection}|${folderId}|${reloadKey}`;
  const mailsReady = mailsResult?.key === mailsKey;
  const status: ListStatus = !mailsReady ? "loading" : mailsResult.error ? "error" : "ready";
  const mails = mailsReady ? mailsResult.mails : EMPTY_MAILS;
  const error = mailsReady ? mailsResult.error : undefined;

  const detailLoading = mailId !== null && detailResult?.key !== mailId;
  const detail = mailId !== null && detailResult?.key === mailId ? detailResult.mail : null;

  useEffect(() => {
    listAccounts().then(setAccounts);
  }, []);

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
    if (folderPending) return;
    let cancelled = false;
    listMails(selection === "all" ? null : selection, folderId)
      .then((result) => {
        if (!cancelled) setMailsResult({ key: mailsKey, mails: result });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMailsResult({
          key: mailsKey,
          mails: [],
          error: toLoadError(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selection, folderId, folderPending, mailsKey]);

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
  }, []);

  const selectFolder = useCallback((id: string, accountId: string) => {
    setSelection(accountId);
    setFolderId(id);
    setMailId(null);
  }, []);

  const index = mailId ? mails.findIndex((m) => m.id === mailId) : -1;
  const move = (delta: number) => {
    const next = mails[index + delta];
    if (next) setMailId(next.id);
  };

  const title = useMemo(() => {
    if (selection === "all") return "통합 받은편지함";
    return folders.find((f) => f.id === folderId)?.name ?? "받은편지함";
  }, [selection, folders, folderId]);

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
        onOpenSettings={() => undefined}
      />
      <div className={styles.body}>
        <AccountRail
          accounts={accounts}
          selected={selection}
          onSelect={selectAccount}
          onAddAccount={() => setAdding(true)}
          onOpenSettings={() => undefined}
        />
        <div ref={folderPaneRef} className={styles.pane}>
          <FolderPane
            account={account}
            accounts={accounts}
            folders={folders}
            selectedId={folderId}
            collapsed={widths.folderCollapsed}
            onSelect={selectFolder}
            onCompose={() => undefined}
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
            selectedId={mailId}
            onSelect={setMailId}
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
        <Reader
          mail={detail}
          loading={detailLoading}
          position={index >= 0 ? `${index + 1} / ${mails.length}` : undefined}
          onPrev={() => move(-1)}
          onNext={() => move(1)}
        />
      </div>
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
