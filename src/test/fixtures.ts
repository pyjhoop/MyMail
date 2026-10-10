// 테스트용 데이터와 가짜 백엔드. 실제 백엔드(Rust)가 주는 모양과 같다.
import type { Account, Folder, RawMailDetail, RawMailSummary } from "../lib/ipc";

export const FAKE_ACCOUNTS: Account[] = [
  {
    id: "a1",
    name: "개인 Gmail",
    email: "junho.park@gmail.com",
    provider: "gmail",
    colorIndex: 1,
    unread: 12,
    initial: "개",
    signature: "",
    signReplies: true,
    notifyEnabled: true,
    notifyScope: "inbox",
    notifySound: true,
    notifyBadge: true,
  },
  {
    id: "a2",
    name: "프로젝트 Gmail",
    email: "junho.dev@gmail.com",
    provider: "gmail",
    colorIndex: 2,
    unread: 3,
    initial: "프",
    signature: "",
    signReplies: true,
    notifyEnabled: true,
    notifyScope: "inbox",
    notifySound: true,
    notifyBadge: true,
  },
  {
    id: "a3",
    name: "네이버",
    email: "junho_p@naver.com",
    provider: "naver",
    colorIndex: 3,
    unread: 128,
    initial: "네",
    signature: "",
    signReplies: true,
    notifyEnabled: true,
    notifyScope: "inbox",
    notifySound: true,
    notifyBadge: true,
  },
];

export const FAKE_FOLDERS: Folder[] = FAKE_ACCOUNTS.map((a) => ({
  id: `${a.id}-inbox`,
  accountId: a.id,
  name: "받은편지함",
  kind: "inbox",
  unread: a.unread,
}));

const NOW = Math.floor(Date.now() / 1000);

export const FAKE_MAILS: RawMailSummary[] = FAKE_ACCOUNTS.map((a, i) => ({
  id: `${a.id}-inbox-0`,
  accountId: a.id,
  folderId: `${a.id}-inbox`,
  sender: "김도윤",
  senderEmail: "doyun.kim@gmail.com",
  subject: `제주 여행 일정 ${i}`,
  preview: "항공권 예매 끝났어!",
  receivedAt: NOW - i * 3600,
  unread: true,
  starred: false,
  hasAttachment: false,
  labels: [],
}));

export const FAKE_DETAIL = (id: string): RawMailDetail | null => {
  const summary = FAKE_MAILS.find((m) => m.id === id);
  return summary
    ? {
        ...summary,
        to: "나",
        body: ["준호야,", "항공권 예매 끝났어!"],
        attachments: [],
        earlier: [],
      }
    : null;
};

/** `invoke` 대역. 명령 이름으로 위 데이터를 돌려준다. */
export async function fakeInvoke(command: string, args: Record<string, unknown> = {}) {
  switch (command) {
    case "list_accounts":
      return FAKE_ACCOUNTS;
    case "list_folders":
      return FAKE_FOLDERS.filter((f) => f.accountId === args.accountId);
    case "list_mails":
      return FAKE_MAILS.filter((m) =>
        args.accountId === null ? true : m.folderId === args.folderId,
      );
    case "search_mails":
      return FAKE_MAILS.filter(
        (m) =>
          (args.accountId === null || m.accountId === args.accountId) &&
          m.subject.includes(args.query as string),
      );
    case "get_mail":
      return FAKE_DETAIL(args.id as string);
    case "get_autostart":
      return false;
    case "sync_now":
    case "set_autostart":
    case "set_signature":
    case "set_sign_replies":
    case "update_account":
    case "reorder_accounts":
    case "remove_account":
      return undefined;
    default:
      throw new Error(`알 수 없는 command: ${command}`);
  }
}
