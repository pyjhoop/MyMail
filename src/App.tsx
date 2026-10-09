import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ResizeHandle } from "./components/ResizeHandle";
import { Toast } from "./components/Toast";
import { TitleBar } from "./components/TitleBar";
import { AccountRail, type AccountSelection } from "./features/accounts/AccountRail";
import { AddAccountDialog } from "./features/accounts/AddAccountDialog";
import { Composer, type ComposeInit, type ComposeResult } from "./features/compose/Composer";
import { startDraft, type ComposeMode } from "./features/compose/compose";
import { Settings } from "./features/settings/Settings";
import { FolderPane } from "./features/folders/FolderPane";
import { MailList, type ListStatus } from "./features/mail/MailList";
import { Reader, type ReaderActions } from "./features/mail/Reader";
import { useMailSort } from "./features/mail/sort";
import { useRefresh } from "./features/mail/useRefresh";
import { FOLDER, RAIL, usePanelWidths } from "./features/shell/usePanelWidths";
import { useShortcuts } from "./features/shell/shortcuts";
import {
  loadTheme,
  saveTheme,
  useTheme,
  type ThemePreference,
} from "./features/shell/useSystemTheme";
import {
  archiveMail,
  deleteMail,
  getDraft,
  getMail,
  isDraftId,
  listAccounts,
  listFolders,
  listMails,
  moveMail,
  onSyncProgress,
  onTrayCompose,
  onWindowFocus,
  searchMails,
  setRead,
  setStarred,
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
/** 보관 뒤 "실행 취소"를 누를 수 있는 시간. 이 시간이 지나야 서버로 보낸다. */
const UNDO_MS = 6000;
/** 보관할 수 없는 폴더의 메일에 보여 주는 안내 */
const ARCHIVE_BLOCKED: Partial<Record<Folder["kind"], string>> = {
  archive: "이미 보관된 메일이에요",
  trash: "이 폴더의 메일은 보관할 수 없어요",
  spam: "이 폴더의 메일은 보관할 수 없어요",
  drafts: "이 폴더의 메일은 보관할 수 없어요",
};
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
  const [sort, setSort] = useMailSort();
  const [mailId, setMailId] = useState<string | null>(null);
  const [syncs, setSyncs] = useState<Record<string, SyncProgress>>({});
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 확인 창이 지울 메일. 목록에서 체크한 메일이거나 단축키로 지우려는 열린 메일이다.
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string>();
  // 보관·이동으로 목록에서 치운 메일. 서버 반영과 목록 다시 읽기가 끝나기 전에도 다시 나타나지 않게 한다.
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [toast, setToast] = useState<{ message: string; undoable: boolean } | null>(null);
  // 열린 메일이 선택한 계정이 아닌 계정의 것일 때(통합 보기·검색) 그 계정의 폴더 목록
  const [otherFolders, setOtherFolders] = useState<{ key: string; folders: Folder[] } | null>(null);
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
  // 안 읽은 수를 다시 읽는 요청 번호. 가장 마지막 요청의 응답만 화면에 반영한다.
  const countsSeq = useRef(0);
  const selectionRef = useRef<AccountSelection>(selection);
  // 읽음 처리를 보낸 메일. 화면이 다시 그려지기 전에 같은 메일을 두 번 보내지 않는다.
  const readInFlight = useRef(new Set<string>());
  // 보관을 눌렀지만 아직 서버로 보내지 않은 메일(실행 취소 대기 중). 한 번에 하나만 둔다.
  const pendingArchive = useRef<{ id: string; row?: MailSummary } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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
  const listedMails = mailsReady ? mailsResult.mails : EMPTY_MAILS;
  const mails = useMemo(
    () => (hiddenIds.size === 0 ? listedMails : listedMails.filter((m) => !hiddenIds.has(m.id))),
    [listedMails, hiddenIds],
  );
  const error = mailsReady ? mailsResult.error : undefined;

  const detailLoading = mailId !== null && detailResult?.key !== mailId;
  const detail = mailId !== null && detailResult?.key === mailId ? detailResult.mail : null;
  const index = mailId ? mails.findIndex((m) => m.id === mailId) : -1;

  const detailAccountId = detail?.accountId;
  useEffect(() => {
    if (!detailAccountId || detailAccountId === selection) return;
    let cancelled = false;
    listFolders(detailAccountId)
      .then((result) => {
        if (!cancelled) setOtherFolders({ key: detailAccountId, folders: result });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [detailAccountId, selection]);
  const readerFolders = !detailAccountId
    ? EMPTY_FOLDERS
    : detailAccountId === selection
      ? folders
      : otherFolders?.key === detailAccountId
        ? otherFolders.folders
        : EMPTY_FOLDERS;

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  // 계정·폴더의 안 읽은 수를 로컬 DB에서 다시 읽는 유일한 경로.
  // 요청마다 번호를 매겨 가장 마지막 요청의 응답만 반영하므로, 늦게 도착한 옛 응답이 새 값을 덮지 않는다.
  const refreshCounts = useCallback(() => {
    const seq = ++countsSeq.current;
    const sel = selectionRef.current;
    Promise.all([listAccounts(), sel === "all" ? null : listFolders(sel)])
      .then(([nextAccounts, nextFolders]) => {
        if (seq !== countsSeq.current) return;
        setAccounts(nextAccounts);
        if (nextFolders) setFoldersResult({ key: sel, folders: nextFolders });
      })
      .catch(() => undefined);
  }, []);

  // 처음과 계정을 바꿀 때: 계정 목록과 그 계정의 폴더 목록을 읽는다.
  useEffect(() => {
    refreshCounts();
  }, [selection, refreshCounts]);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (folderPending && !term) return;
    let cancelled = false;
    const accountArg = selection === "all" ? null : selection;
    (term ? searchMails(accountArg, term, sort) : listMails(accountArg, folderId, sort))
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
  }, [selection, folderId, folderPending, term, mailsScope, reloadKey, sort]);

  // 새로고침 = 서버와 바로 동기화. 끝나면 목록·안 읽은 수를 다시 읽는다.
  const {
    refreshing,
    error: syncError,
    lastSyncedAt,
    refresh,
  } = useRefresh({
    accountId: selection === "all" ? null : selection,
    folderId: folderId || undefined,
    onDone: () => {
      setReloadKey((k) => k + 1);
      refreshCounts();
    },
  });

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

  // 메일의 안 읽은 수를 화면에서 먼저 바꾼다(낙관적 갱신). 받은편지함이 아닌 폴더는 계정 합계에 들지 않는다.
  // 폴더 종류를 알 수 없는 경우(검색 결과 등)는 건드리지 않고 `refreshCounts`가 맞춘다.
  const adjustUnread = (mail: MailSummary, delta: number) => {
    countsSeq.current += 1; // 이미 날아간 옛 응답이 이 변경을 덮지 못하게 한다
    const bump = (n: number) => Math.max(0, n + delta);
    let inbox = false;
    if (selection === "all") {
      inbox = term === "";
    } else if (mail.accountId === selection) {
      const folder = folders.find((f) => f.id === mail.folderId);
      if (folder) {
        inbox = folder.kind === "inbox";
        setFoldersResult((prev) =>
          prev?.key === selection
            ? {
                ...prev,
                folders: prev.folders.map((f) =>
                  f.id === folder.id ? { ...f, unread: bump(f.unread) } : f,
                ),
              }
            : prev,
        );
      }
    }
    if (inbox) {
      setAccounts((prev) =>
        prev.map((a) => (a.id === mail.accountId ? { ...a, unread: bump(a.unread) } : a)),
      );
    }
  };

  // 목록 행과 열린 본문의 읽음 표시를 제자리에서 바꾼다(목록을 다시 불러오면 스켈레톤이 깜빡인다).
  const patchUnread = (id: string, unread: boolean) => {
    setMailsResult((prev) =>
      prev ? { ...prev, mails: prev.mails.map((m) => (m.id === id ? { ...m, unread } : m)) } : prev,
    );
    setDetailResult((prev) =>
      prev?.key === id && prev.mail ? { key: id, mail: { ...prev.mail, unread } } : prev,
    );
  };

  // 읽음 표시를 바꾼다. 화면을 먼저 바꾸고 백엔드에 알리며(서버 반영은 백엔드 큐가 맡는다), 실패하면 되돌린다.
  const changeRead = (id: string, read: boolean) => {
    const row = mails.find((m) => m.id === id);
    if (!row || row.unread === !read || readInFlight.current.has(id)) return;
    readInFlight.current.add(id);
    patchUnread(id, !read);
    adjustUnread(row, read ? -1 : 1);
    setRead(id, read)
      .catch(() => {
        patchUnread(id, read);
        adjustUnread(row, read ? 1 : -1);
      })
      .finally(() => {
        readInFlight.current.delete(id);
        refreshCounts();
      });
  };
  // 메일을 열면 곧바로 `markRead`로 읽음 처리한다. `markUnread`는 "읽지 않음으로 표시"(Reader 더보기 메뉴)가 쓴다.
  const readActions = {
    markRead: (id: string) => changeRead(id, true),
    markUnread: (id: string) => changeRead(id, false),
  };

  // 백그라운드 동기화가 폴더를 하나 끝낼 때마다 목록과 안 읽은 수를 다시 읽는다.
  useEffect(
    () =>
      onSyncProgress((progress) => {
        setSyncs((prev) => ({ ...prev, [progress.accountId]: progress }));
        setReloadKey((k) => k + 1);
        refreshCounts();
      }),
    [refreshCounts],
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

  // 지우거나 옮기는 메일 `exclude` 말고 열 메일: 아래쪽 이웃을 먼저, 없으면 위쪽. 작성 중 메일은 건너뛴다.
  const neighbor = (exclude: string[]): MailSummary | undefined => {
    const ok = (m: MailSummary) => !exclude.includes(m.id) && !isDraftId(m.id);
    return mails.slice(index + 1).find(ok) ?? mails.slice(0, Math.max(index, 0)).reverse().find(ok);
  };
  const openNeighbor = (next: MailSummary | undefined) => {
    setMailId(next?.id ?? null);
    if (next) readActions.markRead(next.id);
  };

  const deleteIds = async (ids: string[]) => {
    setConfirmingDelete(false);
    if (ids.length === 0) return;
    setDeleting(true);
    setNotice(undefined);
    flushArchive();
    // 열어 둔 메일을 지우면 Gmail처럼 다음 메일(없으면 이전 메일)을 연다.
    const next = mailId && ids.includes(mailId) ? neighbor(ids) : undefined;
    let failed = 0;
    // 같은 계정의 IMAP 연결을 번갈아 쓰지 않도록 하나씩 처리한다.
    for (const id of ids) {
      const row = mails.find((m) => m.id === id);
      try {
        await deleteMail(id);
        if (row?.unread) adjustUnread(row, -1);
      } catch {
        failed += 1;
      }
    }
    setDeleting(false);
    setCheckedIds(EMPTY_IDS);
    if (mailId && ids.includes(mailId)) openNeighbor(next);
    if (failed > 0) setNotice(`메일 ${failed}통을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.`);
    setReloadKey((k) => k + 1);
    refreshCounts();
  };

  // 휴지통 안이거나 검색 결과면(휴지통 여부를 모른다) 확인을 받고, 아니면 바로 지운다.
  const requestDelete = (ids: string[]) => {
    if (ids.length === 0) return;
    setPendingIds(ids);
    if (inTrash || term) setConfirmingDelete(true);
    else void deleteIds(ids);
  };

  const showToast = (message: string, undoable: boolean) => {
    clearTimeout(toastTimer.current);
    setToast({ message, undoable });
    toastTimer.current = setTimeout(() => {
      flushRef.current();
      setToast(null);
    }, UNDO_MS);
  };

  const unhide = (id: string) =>
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  // 대기 중인 보관을 서버로 보낸다. 실패하면 메일을 목록에 되돌리고 이유를 알린다.
  const flushArchive = () => {
    const pending = pendingArchive.current;
    if (!pending) return;
    pendingArchive.current = null;
    clearTimeout(toastTimer.current);
    setToast(null);
    archiveMail(pending.id)
      .then(() => {
        setReloadKey((k) => k + 1);
        refreshCounts();
      })
      .catch((e: unknown) => {
        unhide(pending.id);
        if (pending.row?.unread) adjustUnread(pending.row, 1);
        setNotice(`메일을 보관하지 못했어요. ${toLoadError(e).message}`);
        refreshCounts();
      });
  };
  const flushRef = useRef(flushArchive);
  useEffect(() => {
    flushRef.current = flushArchive;
  });
  // 창을 닫을 때 대기 중인 보관을 보낸다(최선을 다할 뿐 보장하지는 않는다).
  useEffect(() => {
    const onUnload = () => flushRef.current();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      clearTimeout(toastTimer.current);
    };
  }, []);

  // 보관: 목록에서 먼저 치우고 실행 취소를 기다린 뒤 서버로 보낸다. 서버가 새 번호를 매기므로 보낸 뒤에는 같은 메일로 되돌릴 수 없어서다.
  const archiveNow = (id: string) => {
    flushArchive();
    const row = mails.find((m) => m.id === id);
    const next = id === mailId ? neighbor([id]) : undefined;
    setHiddenIds((prev) => new Set(prev).add(id));
    if (row?.unread) adjustUnread(row, -1);
    pendingArchive.current = { id, row };
    showToast("보관했어요", true);
    if (id === mailId) openNeighbor(next);
  };

  const undoArchive = () => {
    const pending = pendingArchive.current;
    if (!pending) return;
    pendingArchive.current = null;
    clearTimeout(toastTimer.current);
    setToast(null);
    unhide(pending.id);
    if (pending.row?.unread) adjustUnread(pending.row, 1);
    setMailId(pending.id);
  };

  const currentKind = detail
    ? readerFolders.find((f) => f.id === detail.folderId)?.kind
    : undefined;
  const archiveBlocked = currentKind ? ARCHIVE_BLOCKED[currentKind] : undefined;
  // 스팸함의 메일은 "스팸 아님", 그 밖의 메일은 "스팸으로 신고"(스팸함이 있을 때만). 휴지통의 메일은 뺀다.
  const spamItem =
    currentKind === "spam"
      ? readerFolders.some((f) => f.kind === "inbox")
        ? { isSpam: true }
        : undefined
      : currentKind !== "trash" && readerFolders.some((f) => f.kind === "spam")
        ? { isSpam: false }
        : undefined;

  const patchStarred = (id: string, starred: boolean) => {
    setMailsResult((prev) =>
      prev
        ? { ...prev, mails: prev.mails.map((m) => (m.id === id ? { ...m, starred } : m)) }
        : prev,
    );
    setDetailResult((prev) =>
      prev?.key === id && prev.mail ? { key: id, mail: { ...prev.mail, starred } } : prev,
    );
  };
  const changeStarred = (id: string, starred: boolean) => {
    patchStarred(id, starred);
    setStarred(id, starred).catch(() => {
      patchStarred(id, !starred);
      setNotice("별표를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.");
    });
  };

  // 같은 계정의 다른 폴더로 옮긴다(폴더로 이동·스팸 신고). 열린 메일이면 다음 메일을 연다.
  const moveTo = async (id: string, folder: Folder, message: string) => {
    flushArchive();
    const row = mails.find((m) => m.id === id);
    const next = id === mailId ? neighbor([id]) : undefined;
    try {
      await moveMail(id, folder.id);
    } catch (e) {
      setNotice(`메일을 옮기지 못했어요. ${toLoadError(e).message}`);
      return;
    }
    setHiddenIds((prev) => new Set(prev).add(id));
    if (row?.unread) adjustUnread(row, -1);
    if (id === mailId) openNeighbor(next);
    setReloadKey((k) => k + 1);
    refreshCounts();
    showToast(message, false);
  };

  const spamFolder = readerFolders.find((f) => f.kind === "spam");
  const inboxFolder = readerFolders.find((f) => f.kind === "inbox");
  const readerActions: ReaderActions | undefined = detail
    ? {
        onDelete: () => requestDelete([detail.id]),
        onArchive: () => archiveNow(detail.id),
        archiveBlockedReason: archiveBlocked,
        more: {
          moveTargets: readerFolders.filter((f) => f.id !== detail.folderId && f.kind !== "drafts"),
          spam: spamItem,
          onSetRead: (read) =>
            read ? readActions.markRead(detail.id) : readActions.markUnread(detail.id),
          onSetStarred: (starred) => changeStarred(detail.id, starred),
          onMove: (folder) => void moveTo(detail.id, folder, `"${folder.name}"으로 옮겼어요`),
          onToggleSpam: () => {
            if (currentKind === "spam" && inboxFolder) {
              void moveTo(detail.id, inboxFolder, "받은편지함으로 옮겼어요");
            } else if (spamFolder) {
              void moveTo(detail.id, spamFolder, "스팸으로 신고했어요");
            }
          },
        },
      }
    : undefined;

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
    readActions.markRead(id);
  };

  const finishCompose = (result: ComposeResult) => {
    setCompose(null);
    if (result === "sent") setNotice("메일을 보냈어요.");
    setReloadKey((k) => k + 1);
    refreshCounts();
  };

  const move = (delta: number) => {
    const next = mails[index + delta];
    if (!next) return;
    setMailId(next.id);
    readActions.markRead(next.id);
  };

  // 작성기가 열려 있으면 메일 조작 단축키는 쉬고(작성 내용을 덮어쓰지 않게) 계정 전환만 쓴다.
  const composing = compose !== null;
  useShortcuts(
    {
      compose: () => !composing && startCompose("new"),
      reply: () => !composing && detail && startCompose("reply"),
      replyAll: () => !composing && detail && startCompose("replyAll"),
      forward: () => !composing && detail && startCompose("forward"),
      archive: () => !composing && mailId && !archiveBlocked && archiveNow(mailId),
      remove: () => !composing && mailId && requestDelete([mailId]),
      search: () => searchInputRef.current?.focus(),
      next: () => !composing && move(1),
      prev: () => !composing && move(-1),
      refresh,
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
              onRefresh={refresh}
              refreshing={refreshing}
              syncError={syncError}
              lastSyncedAt={lastSyncedAt}
              sort={sort}
              onSortChange={setSort}
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
              actions={readerActions}
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
      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.undoable ? "실행 취소" : undefined}
          onAction={undoArchive}
        />
      )}
      {adding && (
        <AddAccountDialog
          accounts={accounts}
          onClose={() => setAdding(false)}
          onAdded={(added) => {
            setAccounts((prev) => [...prev, added]);
            selectAccount(added.id);
          }}
        />
      )}
    </div>
  );
}

export default App;
