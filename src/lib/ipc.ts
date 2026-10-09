// 백엔드 호출 경계. M1에서는 가짜 데이터를 돌려주고, M2에서 Tauri command(invoke)로 교체한다.
import { FAKE_ACCOUNTS, FAKE_FOLDERS, FAKE_MAILS } from "./fakeData";

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function listAccounts(): Promise<Account[]> {
  return FAKE_ACCOUNTS;
}

export async function listFolders(accountId: string): Promise<Folder[]> {
  return FAKE_FOLDERS.filter((f) => f.accountId === accountId);
}

/** accountId가 null이면 통합 받은편지함 */
export async function listMails(
  accountId: string | null,
  folderId: string,
): Promise<MailSummary[]> {
  await delay(150);
  return FAKE_MAILS.filter((m) =>
    accountId === null
      ? FAKE_FOLDERS.find((f) => f.id === m.folderId)?.kind === "inbox"
      : m.folderId === folderId,
  );
}

export async function getMail(id: string): Promise<MailDetail | null> {
  const summary = FAKE_MAILS.find((m) => m.id === id);
  if (!summary) return null;
  return {
    ...summary,
    to: "나, 김하은 외 1명",
    fullTime: "오늘 오전 9:12 (1시간 전)",
    body: [
      "준호야,",
      "항공권 예매 끝났어! 10월 23일(금) 김포 → 제주 19:20 출발이고, 돌아오는 건 26일(월) 오후 2시 비행기야. 일정표 정리해서 첨부했으니까 보고 가고 싶은 곳 있으면 표에 바로 추가해 줘.",
      "숙소는 애월 쪽 독채로 잡았고 체크인은 오후 4시부터래.",
      "렌터카 예약되면 확인 메일 전달해 줘!\n도윤",
    ],
    attachments: [
      { name: "제주여행_일정표.pdf", size: "1.2 MB", ext: "PDF" },
      { name: "항공권_전자티켓.pdf", size: "384 KB", ext: "PDF" },
      { name: "숙소_외관.jpg", size: "2.4 MB", ext: "JPG" },
    ],
    earlier: [
      {
        sender: "나",
        initial: "나",
        preview: "도윤아, 항공편 시간 정해지면 알려줘. 렌터카는 내가 알아볼게.",
        date: "10월 6일",
      },
      {
        sender: "김도윤",
        initial: "도",
        preview: "응 금요일 저녁 비행기로 잡으려고. 내일 확정해서 보낼게!",
        date: "10월 7일",
      },
    ],
  };
}
