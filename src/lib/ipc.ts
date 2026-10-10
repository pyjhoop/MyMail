// 백엔드 호출 경계. 컴포넌트는 invoke를 직접 부르지 않고 이 파일의 함수만 쓴다.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { formatFullTime, formatListTime, formatSize } from "./format";
import { isOpenableLink } from "./mailHtml";

export type Provider = "gmail" | "naver";

export interface Account {
  id: string;
  name: string;
  email: string;
  provider: Provider;
  /** 1~8, tokens.css의 --account-N */
  colorIndex: number;
  unread: number;
  /** 아바타에 보이는 한 글자 */
  initial: string;
  /** 새 메일·답장 끝에 넣는 서명 (일반 텍스트) */
  signature: string;
  /** 답장·전달에도 서명을 넣을지 */
  signReplies: boolean;
}

export type FolderKind =
  "inbox" | "sent" | "drafts" | "spam" | "trash" | "archive" | "label" | "folder";

export interface Folder {
  id: string;
  accountId: string;
  name: string;
  kind: FolderKind;
  unread: number;
  /** 라벨 색 점 (1~8) */
  colorIndex?: number;
  /** 폴더 계층 깊이 (0 = 최상위) */
  depth?: number;
  /** 하위 폴더를 가진 폴더 */
  expandable?: boolean;
}

export interface MailSummary {
  id: string;
  accountId: string;
  folderId: string;
  sender: string;
  senderEmail: string;
  subject: string;
  preview: string;
  /** 표시용 시간 ("오전 9:12", "어제", "10월 6일") */
  time: string;
  unread: boolean;
  starred: boolean;
  hasAttachment: boolean;
  /** 스레드 안 메일 수 (2 이상일 때만 표시) */
  threadCount?: number;
  /** 붙은 라벨 전체(시스템 라벨 제외). 없으면 빈 배열 */
  labels: { name: string; colorIndex: number }[];
}

export interface MailAttachment {
  /** 저장할 때 가리키는 번호. 이름이 같은 첨부도 구분한다. */
  id: number;
  name: string;
  size: string;
  ext: string;
}

export interface MailDetail extends MailSummary {
  to: string;
  /** 텍스트 본문 문단 배열. HTML이 없는 메일은 이것을 그대로 보여준다. */
  body: string[];
  /** 정제 전 원문 HTML (`cid:` 이미지는 data URI로 바뀐 상태). 표시 전에 반드시 정제한다. */
  html?: string;
  attachments: MailAttachment[];
  /** 본문 위에 접어 두는 이전 메일 */
  earlier: { sender: string; initial: string; preview: string; date: string }[];
  fullTime: string;
  /** 받은 시각(유닉스 초). 답장 인용 머리말에 쓴다 */
  receivedAt?: number;
}

export type LoadError = { kind: "network" | "auth" | "unknown"; message: string };

/** 백엔드가 주는 메일 요약. 시간은 유닉스 초, 표시용 문구는 여기서 만든다. */
export type RawMailSummary = Omit<MailSummary, "time"> & { receivedAt: number };

export interface RawMailDetail extends RawMailSummary {
  to: string;
  body: string[];
  html?: string | null;
  attachments: { id: number; name: string; size: number; ext: string }[];
  earlier: { sender: string; initial: string; preview: string; receivedAt: number }[];
}

const toSummary = ({ receivedAt, ...rest }: RawMailSummary): MailSummary => ({
  ...rest,
  time: formatListTime(receivedAt),
});

/** Tauri command의 오류({ kind, message })를 LoadError로 맞춘다 */
export function toLoadError(e: unknown): LoadError {
  if (typeof e === "object" && e !== null && "message" in e) {
    const { kind, message } = e as { kind?: string; message: unknown };
    return {
      kind: kind === "network" || kind === "auth" ? kind : "unknown",
      message: String(message),
    };
  }
  return { kind: "unknown", message: String(e) };
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw toLoadError(e);
  }
}

/** 접속을 확인하고 계정을 추가한다. 실패하면 LoadError(kind: "auth" | "network" | "unknown")로 던진다. */
export function addAccount(input: {
  provider: Provider;
  email: string;
  password: string;
  /** 표시 이름. 비우면 메일 주소 */
  name?: string;
  /** 계정 색 1~8. 비우면 계정 수에 따라 자동 */
  colorIndex?: number;
}): Promise<Account> {
  return call("add_account", input);
}

export function listAccounts(): Promise<Account[]> {
  return call("list_accounts");
}

export function listFolders(accountId: string): Promise<Folder[]> {
  return call("list_folders", { accountId });
}

/** 메일 목록 정렬. 백엔드가 이 값만 받아들인다(그 밖의 값은 거절). */
export type MailSort = "newest" | "oldest" | "sender" | "subject" | "unread";

/** accountId가 null이면 통합 받은편지함 */
export async function listMails(
  accountId: string | null,
  folderId: string,
  sort: MailSort = "newest",
): Promise<MailSummary[]> {
  const mails = await call<RawMailSummary[]>("list_mails", { accountId, folderId, sort });
  return mails.map(toSummary);
}

/** 제목·보낸사람·본문 검색. accountId가 null이면 모든 계정. */
export async function searchMails(
  accountId: string | null,
  query: string,
  sort: MailSort = "newest",
): Promise<MailSummary[]> {
  const mails = await call<RawMailSummary[]>("search_mails", { accountId, query, sort });
  return mails.map(toSummary);
}

export async function getMail(id: string): Promise<MailDetail | null> {
  const raw = await call<RawMailDetail | null>("get_mail", { id });
  if (!raw) return null;
  return {
    ...toSummary(raw),
    to: raw.to,
    body: raw.body,
    html: raw.html ?? undefined,
    fullTime: formatFullTime(raw.receivedAt),
    receivedAt: raw.receivedAt,
    attachments: raw.attachments.map((a) => ({ ...a, size: formatSize(a.size) })),
    earlier: raw.earlier.map((e) => ({
      sender: e.sender,
      initial: e.initial,
      preview: e.preview,
      date: formatListTime(e.receivedAt),
    })),
  };
}

/** 저장 대화상자를 닫으면 `cancelled`(오류 아님). */
export type SaveResult = { status: "cancelled" } | { status: "saved"; count: number };

/** 첨부 하나를 저장한다. 저장 위치는 백엔드가 파일 저장 대화상자로 묻는다. */
export function saveAttachment(mailId: string, attachmentId: number): Promise<SaveResult> {
  return call("save_attachment", { mailId, attachmentId });
}

/** 메일의 첨부를 모두 저장한다. 폴더를 고르는 대화상자가 열린다. */
export function saveAllAttachments(mailId: string): Promise<SaveResult> {
  return call("save_all_attachments", { mailId });
}

/** 방금 저장한 첨부를 탐색기에서 보여 준다. attachmentId를 생략하면 "모두 저장"한 폴더. */
export function revealSavedAttachment(mailId: string, attachmentId?: number): Promise<void> {
  return call("reveal_saved_attachment", { mailId, attachmentId: attachmentId ?? null });
}

/** 읽음 표시를 바꾼다. 로컬에 바로 반영되고 서버에는 백그라운드로 보낸다(오프라인이면 연결 뒤에). */
export function setRead(id: string, read: boolean): Promise<void> {
  return call("set_read", { id, read });
}

export function setStarred(id: string, starred: boolean): Promise<void> {
  return call("set_starred", { id, starred });
}

/** 휴지통 밖의 메일은 휴지통으로, 휴지통 안의 메일은 완전히 지운다. */
export function deleteMail(id: string): Promise<void> {
  return call("delete_mail", { id });
}

/** 같은 계정의 다른 폴더로 옮긴다. 옮긴 메일은 서버 반영 뒤 대상 폴더에 다시 나타난다. */
export function moveMail(id: string, folderId: string): Promise<void> {
  return call("move_mail", { id, folderId });
}

/** 휴지통·스팸함의 모든 메일을 완전히 지운다. 다른 폴더는 백엔드가 거절한다. */
export function emptyFolder(accountId: string, folderId: string): Promise<void> {
  return call("empty_folder", { accountId, folderId });
}

/**
 * 메일을 이 계정의 보관 폴더로 옮긴다(Gmail은 전체보관함, 네이버는 "보관함" 폴더 — 없으면 서버에 만든다).
 * 이미 보관·휴지통·스팸·임시보관함에 있는 메일이거나 폴더를 만들 수 없으면 한국어 안내와 함께 던진다.
 */
export function archiveMail(id: string): Promise<void> {
  return call("archive_mail", { id });
}

/** 링크를 기본 브라우저(메일 주소는 기본 메일 앱)로 연다. 앱 창 안에서는 이동하지 않는다. */
export async function openExternal(url: string): Promise<void> {
  if (!isOpenableLink(url)) return;
  await openUrl(url.trim());
}

/**
 * 지금 서버와 동기화하고 끝나면 돌아온다. accountId가 null이면 모든 계정.
 * openFolderId(지금 보는 폴더)는 가장 먼저 맞추고 이후 더 자주 맞춘다.
 * 이미 동기화 중이면 그것이 끝나길 기다리고, 연달아 불러도 한 번만 돈다.
 */
export function syncNow(accountId: string | null, openFolderId?: string): Promise<void> {
  return call("sync_now", { accountId, openFolderId: openFolderId ?? null });
}

/** 창이 포커스를 얻을 때(트레이에서 다시 열 때 포함)를 구독한다. 브라우저(pnpm dev)·테스트에서는 아무 일도 하지 않는다. */
export function onWindowFocus(callback: () => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => undefined;
  const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) callback();
  });
  return () => {
    void unlisten.then((fn) => fn());
  };
}

/** 백그라운드 동기화 진행 상황 (받을 메일 수 단위. 받을 게 없으면 done === total === 0) */
export interface SyncProgress {
  accountId: string;
  done: number;
  total: number;
  /** 중간에 실패했을 때의 안내. 이미 받은 메일은 남아 있다. */
  error: string | null;
}

/** 진행 상황을 구독한다. 브라우저(pnpm dev)·테스트에서는 아무 일도 하지 않는다. 반환값은 구독 해제 함수. */
export function onSyncProgress(callback: (progress: SyncProgress) => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => undefined;
  const unlisten = listen<SyncProgress>("sync-progress", (e) => callback(e.payload));
  return () => {
    void unlisten.then((fn) => fn());
  };
}

/** 트레이 메뉴의 "새 메일"을 구독한다. 브라우저(pnpm dev)·테스트에서는 아무 일도 하지 않는다. */
export function onTrayCompose(callback: () => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => undefined;
  const unlisten = listen("tray-compose", () => callback());
  return () => {
    void unlisten.then((fn) => fn());
  };
}

/** 받는사람 한 명. 주소 목록은 `이름 <주소>` 또는 `주소` 문자열로 오간다. */
export interface Recipient {
  name: string;
  email: string;
}

export function parseRecipient(raw: string): Recipient {
  const text = raw.trim();
  const open = text.lastIndexOf("<");
  const close = text.lastIndexOf(">");
  if (open >= 0 && close > open) {
    return {
      name: text.slice(0, open).trim().replace(/^"|"$/g, "").trim(),
      email: text.slice(open + 1, close).trim(),
    };
  }
  return { name: "", email: text };
}

export function formatRecipient({ name, email }: Recipient): string {
  return name ? `${name} <${email}>` : email;
}

/** 작성 중이거나 보내지 못한 메일. id는 항상 `draft:`로 시작한다. */
export interface Draft {
  id: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** 답장 인용 머리말 한 줄. 인용이 없으면 빈 문자열 */
  quoteHeader: string;
  /** 답장 인용 원문. `>` 없이 그대로 두고, 보낼 때 백엔드가 `> `를 붙인다 */
  quoteText: string;
  /** failed: 보내기에 실패해 임시보관함에 남은 메일 */
  status: "draft" | "failed";
  error: string | null;
  attachments: { id: number; name: string; size: number }[];
}

export type DraftFields = Omit<Draft, "status" | "error" | "attachments">;

export const DRAFT_PREFIX = "draft:";

export const isDraftId = (id: string) => id.startsWith(DRAFT_PREFIX);

export function newDraftId(): string {
  return `${DRAFT_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 작성 내용을 저장한다(자동 저장). 첨부는 건드리지 않는다. */
export function saveDraft(draft: DraftFields): Promise<void> {
  return call("save_draft", { draft });
}

export function getDraft(id: string): Promise<Draft | null> {
  return call("get_draft", { id });
}

/** 작성 중인 메일을 첨부와 함께 버린다. */
export function discardDraft(id: string): Promise<void> {
  return call("discard_draft", { id });
}

/** 첨부를 더한다. 서비스의 용량 한도를 넘으면 LoadError로 던진다. 먼저 `saveDraft`로 메일을 만들어 둬야 한다. */
export async function addDraftAttachment(id: string, file: File): Promise<number> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // 큰 파일에서 호출 스택이 넘치지 않도록 조각내어 base64로 바꾼다.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return call("add_draft_attachment", {
    id,
    name: file.name,
    mime: file.type,
    data: btoa(binary),
  });
}

export function removeDraftAttachment(id: string, attachmentId: number): Promise<void> {
  return call("remove_draft_attachment", { id, attachmentId });
}

/** 저장해 둔 작성 내용을 보낸다. 실패하면 메일은 임시보관함에 `failed`로 남고 LoadError로 던진다. */
export function sendDraft(id: string): Promise<void> {
  return call("send_draft", { id });
}

/** 받는사람 자동완성 후보 */
export function suggestAddresses(query: string): Promise<Recipient[]> {
  return call("suggest_addresses", { query });
}

export function setSignature(accountId: string, signature: string): Promise<void> {
  return call("set_signature", { accountId, signature });
}

export function setSignReplies(accountId: string, on: boolean): Promise<void> {
  return call("set_sign_replies", { accountId, on });
}

/** 표시 이름과 계정 색(1~8)을 바꾼다 */
export function updateAccount(accountId: string, name: string, colorIndex: number): Promise<void> {
  return call("update_account", { accountId, name, colorIndex });
}

/** 계정 레일 순서를 저장한다 */
export function reorderAccounts(ids: string[]): Promise<void> {
  return call("reorder_accounts", { ids });
}

/** 계정과 저장된 메일·비밀번호를 지운다(서버의 메일은 그대로) */
export function removeAccount(accountId: string): Promise<void> {
  return call("remove_account", { accountId });
}

/** Windows 시작 시 실행 여부 */
export function getAutostart(): Promise<boolean> {
  return call("get_autostart");
}

export function setAutostart(enabled: boolean): Promise<void> {
  return call("set_autostart", { enabled });
}

/** 설치된 앱 버전 */
export function appVersion(): Promise<string> {
  return call("app_version");
}

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** 새 버전이 있으면 정보를, 없으면 null을 돌려준다. */
export function checkUpdate(): Promise<UpdateInfo | null> {
  return call("check_update");
}

/** 새 버전을 받아 설치한다. 설치가 시작되면 앱이 닫혔다가 다시 열린다. */
export function installUpdate(): Promise<void> {
  return call("install_update");
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export function onUpdateProgress(callback: (p: UpdateProgress) => void): () => void {
  const unlisten = listen<UpdateProgress>("update-progress", (e) => callback(e.payload));
  return () => {
    void unlisten.then((fn) => fn());
  };
}
