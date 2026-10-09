// M1 임시 가짜 데이터. M2에서 DB + FakeProvider로 대체되면 삭제한다.
import type { Account, Folder, MailSummary } from "./ipc";

export const FAKE_ACCOUNTS: Account[] = [
  {
    id: "a1",
    name: "개인 Gmail",
    email: "junho.park@gmail.com",
    provider: "gmail",
    colorIndex: 1,
    unread: 12,
    initial: "개",
  },
  {
    id: "a2",
    name: "프로젝트 Gmail",
    email: "junho.dev@gmail.com",
    provider: "gmail",
    colorIndex: 2,
    unread: 3,
    initial: "프",
  },
  {
    id: "a3",
    name: "네이버",
    email: "junho_p@naver.com",
    provider: "naver",
    colorIndex: 3,
    unread: 128,
    initial: "네",
  },
];

const base = (accountId: string): Folder[] => [
  { id: `${accountId}-inbox`, accountId, name: "받은편지함", kind: "inbox", unread: 0 },
  { id: `${accountId}-sent`, accountId, name: "보낸편지함", kind: "sent", unread: 0 },
  { id: `${accountId}-drafts`, accountId, name: "임시보관함", kind: "drafts", unread: 2 },
  { id: `${accountId}-spam`, accountId, name: "스팸", kind: "spam", unread: 4 },
  { id: `${accountId}-trash`, accountId, name: "휴지통", kind: "trash", unread: 0 },
];

const unreadOf = (id: string) => FAKE_ACCOUNTS.find((a) => a.id === id)?.unread ?? 0;

export const FAKE_FOLDERS: Folder[] = [
  ...FAKE_ACCOUNTS.flatMap((a) =>
    base(a.id).map((f) => (f.kind === "inbox" ? { ...f, unread: unreadOf(a.id) } : f)),
  ),
  { id: "a1-l-family", accountId: "a1", name: "가족", kind: "label", unread: 1, colorIndex: 5 },
  { id: "a1-l-travel", accountId: "a1", name: "여행", kind: "label", unread: 2, colorIndex: 6 },
  { id: "a1-l-finance", accountId: "a1", name: "금융", kind: "label", unread: 1, colorIndex: 7 },
  { id: "a1-l-shop", accountId: "a1", name: "쇼핑", kind: "label", unread: 0, colorIndex: 3 },
  { id: "a1-l-news", accountId: "a1", name: "뉴스레터", kind: "label", unread: 3, colorIndex: 4 },
  {
    id: "a1-f-move",
    accountId: "a1",
    name: "이사 준비",
    kind: "folder",
    unread: 0,
    expandable: true,
    depth: 0,
  },
  { id: "a1-f-contract", accountId: "a1", name: "계약·서류", kind: "folder", unread: 1, depth: 1 },
  { id: "a1-f-quote", accountId: "a1", name: "이사 견적", kind: "folder", unread: 0, depth: 1 },
];

const SENDERS = [
  ["김도윤", "doyun.kim@gmail.com"],
  ["한빛이사 상담팀", "help@hanbit-move.kr"],
  ["이서연", "seoyeon@naver.com"],
  ["토스뱅크", "noreply@toss.im"],
  ["쿠팡", "no-reply@coupang.com"],
  ["GeekNews", "news@geeknews.io"],
] as const;

const SUBJECTS = [
  "10월 가족여행 일정표랑 항공권 보내줄게",
  "이사 견적 요청드립니다 (11/15, 망원동 → 성산동)",
  "Re: 이번 주 토요일 북한산 갈래?",
  "10월 카드 명세서가 도착했습니다",
  "주문하신 상품이 배송 출발했어요",
  "이번 주 개발 뉴스 요약",
];

const PREVIEWS = [
  "항공권 예매 끝났어! 10월 23일(금) 김포 → 제주 19:20 출발이고…",
  "안녕하세요, 견적 요청 주신 내용 확인했습니다. 방문 상담 가능한 시간대를…",
  "토요일 아침 8시에 불광역에서 보면 어때? 날씨 괜찮을 것 같아서…",
  "이번 달 결제 예정 금액과 상세 내역을 확인해 보세요.",
  "택배가 오늘 중으로 도착할 예정입니다. 문 앞에 두고 가겠습니다.",
  "이번 주에 읽을 만한 글 12개를 골랐어요.",
];

const TIMES = ["오전 9:12", "오전 8:40", "어제", "어제", "10월 7일", "10월 6일"];

/** 계정별 받은편지함 여러 건 (가상화 확인용으로 많이 만든다) */
export const FAKE_MAILS: MailSummary[] = FAKE_ACCOUNTS.flatMap((account, ai) =>
  Array.from({ length: ai === 0 ? 2000 : 300 }, (_, i): MailSummary => {
    const k = (i + ai) % SENDERS.length;
    const [sender, senderEmail] = SENDERS[k];
    return {
      id: `${account.id}-m${i}`,
      accountId: account.id,
      folderId: `${account.id}-inbox`,
      sender,
      senderEmail,
      subject: SUBJECTS[k],
      preview: PREVIEWS[k],
      time: TIMES[Math.min(i, TIMES.length - 1)],
      unread: i % 4 === 0,
      starred: i % 7 === 0,
      hasAttachment: i % 5 === 0,
      threadCount: i % 6 === 0 ? 3 : undefined,
      label: i % 3 === 0 && ai === 0 ? { name: "여행", colorIndex: 6 } : undefined,
    };
  }),
);
