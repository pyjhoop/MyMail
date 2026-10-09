// 백엔드 호출 경계. 컴포넌트는 invoke를 직접 부르지 않고 이 파일의 함수만 쓴다.
import { invoke } from "@tauri-apps/api/core";
import { formatFullTime, formatListTime, formatSize } from "./format";

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
  /** 문단 배열 (M1은 일반 텍스트, HTML 렌더링은 이후 단계) */
  body: string[];
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
