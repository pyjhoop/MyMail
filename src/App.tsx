import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ResizeHandle } from "./components/ResizeHandle";
import { TitleBar } from "./components/TitleBar";
import { AccountRail, type AccountSelection } from "./features/accounts/AccountRail";
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
  toLoadError,
  type Account,
  type Folder,
  type LoadError,
  type MailDetail,
  type MailSummary,
} from "./lib/ipc";
import styles from "./App.module.css";

const EMPTY_MAILS: MailSummary[] = [];
const EMPTY_FOLDERS: Folder[] = [];

function App() {
  useSystemTheme();
  const { widths, dragFolder, dragList, endDrag, resetFolder, resetList } = usePanelWidths();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selection, setSelection] = useState<AccountSelection>("all");
  const [folderId, setFolderId] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [mailId, setMailId] = useState<string | null>(null);

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
  }, [selection]);

  useEffect(() => {
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
  }, [selection, folderId, mailsKey]);

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

  const selectAccount = useCallback((next: AccountSelection) => {
    setSelection(next);
    setFolderId(next === "all" ? "" : `${next}-inbox`);
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

  const folderWidth = widths.folderCollapsed ? FOLDER.collapsed : widths.folder;
  const shellStyle = {
    "--folder-width": `${widths.folder}px`,
    "--list-width": `${widths.list}px`,
  } as CSSProperties;

  return (
    <div className={styles.app} style={shellStyle}>
      <TitleBar syncLabel="방금 동기화됨" onOpenSettings={() => undefined} />
      <div className={styles.body}>
        <AccountRail
          accounts={accounts}
          selected={selection}
          onSelect={selectAccount}
          onAddAccount={() => undefined}
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
    </div>
  );
}

export default App;
