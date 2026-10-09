// 백엔드 호출 경계. 컴포넌트는 invoke를 직접 부르지 않고 이 파일의 함수만 쓴다.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
}

export type FolderKind = "inbox" | "sent" | "drafts" | "spam" | "trash" | "label" | "folder";

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
  label?: { name: string; colorIndex: number };
}

export interface MailAttachment {
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
}

export type LoadError = { kind: "network" | "auth" | "unknown"; message: string };

/** 백엔드가 주는 메일 요약. 시간은 유닉스 초, 표시용 문구는 여기서 만든다. */
export type RawMailSummary = Omit<MailSummary, "time"> & { receivedAt: number };

export interface RawMailDetail extends RawMailSummary {
  to: string;
  body: string[];
  html?: string | null;
  attachments: { name: string; size: number; ext: string }[];
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
  name?: string;
}): Promise<Account> {
  return call("add_account", input);
}

export function listAccounts(): Promise<Account[]> {
  return call("list_accounts");
}

export function listFolders(accountId: string): Promise<Folder[]> {
  return call("list_folders", { accountId });
}

/** accountId가 null이면 통합 받은편지함 */
export async function listMails(
  accountId: string | null,
  folderId: string,
): Promise<MailSummary[]> {
  const mails = await call<RawMailSummary[]>("list_mails", { accountId, folderId });
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
    attachments: raw.attachments.map((a) => ({ ...a, size: formatSize(a.size) })),
    earlier: raw.earlier.map((e) => ({
      sender: e.sender,
      initial: e.initial,
      preview: e.preview,
      date: formatListTime(e.receivedAt),
    })),
  };
}

/** 링크를 기본 브라우저(메일 주소는 기본 메일 앱)로 연다. 앱 창 안에서는 이동하지 않는다. */
export async function openExternal(url: string): Promise<void> {
  if (!isOpenableLink(url)) return;
  await openUrl(url.trim());
}

/** 백그라운드 동기화 진행 상황 (폴더 단위) */
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
