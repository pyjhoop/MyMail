// 작성기의 순수 로직: 새 메일·답장·전달 초안 만들기, 서명 넣기·바꾸기, 주소 다루기.
import { formatQuoteTime } from "../../lib/format";
import {
  formatRecipient,
  newDraftId,
  parseRecipient,
  type Account,
  type DraftFields,
  type MailDetail,
} from "../../lib/ipc";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

/** 서명 앞에 붙는 구분선. 메일 클라이언트 관례(`-- `, 끝에 공백 한 칸)를 따른다. */
const SIGNATURE_MARK = "-- \n";

/** 본문에 들어가는 서명 덩어리. 서명이 없으면 빈 문자열 */
export function signatureBlock(signature: string): string {
  const text = signature.trim();
  return text ? `${SIGNATURE_MARK}${text}` : "";
}

/** 계정을 바꾸거나 서명을 고쳤을 때 본문의 서명을 새 것으로 바꾼다. 서명을 직접 고쳤다면 그대로 둔다. */
export function swapSignature(body: string, from: string, to: string): string {
  const oldBlock = signatureBlock(from);
  const newBlock = signatureBlock(to);
  if (oldBlock === newBlock) return body;
  if (oldBlock && body.includes(oldBlock)) {
    // 서명을 지우면 앞의 빈 줄도 함께 정리한다.
    return newBlock
      ? body.replace(oldBlock, newBlock)
      : body.replace(`\n\n${oldBlock}`, "").replace(oldBlock, "");
  }
  if (!oldBlock && newBlock) return `${body.trimEnd()}\n\n${newBlock}`;
  return body;
}

const REPLY_PREFIX = /^\s*(re|회신)\s*:\s*/i;
const FORWARD_PREFIX = /^\s*(fwd?|전달)\s*:\s*/i;

function withPrefix(subject: string, prefix: string, existing: RegExp): string {
  return `${prefix}: ${subject.replace(existing, "")}`;
}

/** 전달 본문에 남겨 두는 원문 인용의 최대 단계. 이보다 깊은 인용은 "⋯" 한 줄로 접는다. */
export const MAX_QUOTE_DEPTH = 3;

/** 줄 맨 앞의 `>` 개수(인용 단계). 사이의 공백은 무시한다. */
function quoteDepth(line: string): number {
  const lead = /^(?:[ \t]*>)+/.exec(line)?.[0] ?? "";
  return lead.split(">").length - 1;
}

/**
 * 원문에 이미 들어 있는 `>` 인용 중 maxDepth단계를 넘는 줄을 접는다.
 * 이어지는 깊은 줄은 maxDepth단계의 "⋯" 한 줄로 바뀌어, `> > > >`가 끝없이 쌓이지 않는다.
 */
export function foldDeepQuotes(text: string, maxDepth: number = MAX_QUOTE_DEPTH): string {
  const out: string[] = [];
  let folding = false;
  for (const line of text.split("\n")) {
    if (quoteDepth(line) > maxDepth) {
      if (!folding) out.push(`${"> ".repeat(maxDepth)}⋯`);
      folding = true;
    } else {
      folding = false;
      out.push(line);
    }
  }
  return out.join("\n");
}

/** 원문 본문 전체(문단은 빈 줄로 잇는다) */
function plainBody(mail: MailDetail): string {
  return mail.body.join("\n\n");
}

/** 답장 인용 머리말: "2026년 10월 9일 오후 3:20, 홍길동 <a@b.com>님이 작성:" */
function quoteHeaderOf(mail: MailDetail): string {
  const when = mail.receivedAt != null ? formatQuoteTime(mail.receivedAt) : mail.fullTime;
  return `${when}, ${senderOf(mail)}님이 작성:`;
}

/** 보낸 사람을 `이름 <주소>`로. 이름이 주소와 같으면 주소만 쓴다. */
function senderOf(mail: MailDetail): string {
  const name = mail.sender === mail.senderEmail ? "" : mail.sender;
  return formatRecipient({ name, email: mail.senderEmail });
}

/** 받는사람 문자열(쉼표로 구분)에서 내 주소와 중복을 뺀 목록 */
function othersOf(mail: MailDetail, ownEmail: string, exclude: string[]): string[] {
  const skip = new Set([ownEmail, ...exclude].map((e) => e.toLowerCase()));
  const seen = new Set<string>();
  return mail.to
    .split(",")
    .map((t) => t.trim())
    .filter((t) => {
      const { email } = parseRecipient(t);
      const key = email.toLowerCase();
      if (!email.includes("@") || skip.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export interface ComposeStart {
  mode: ComposeMode;
  /** 보내는 계정. 답장·전달은 원본이 속한 계정 */
  account: Account;
  /** 답장·전달할 원본 */
  mail?: MailDetail;
}

/** 작성기를 열 때의 초기 내용. 아직 저장하지 않은 상태다. */
export function startDraft({ mode, account, mail }: ComposeStart): DraftFields {
  const base = {
    id: newDraftId(),
    accountId: account.id,
    to: [],
    cc: [],
    bcc: [],
    quoteHeader: "",
    quoteText: "",
  };
  const sig = signatureBlock(account.signature);
  const newSigned = sig ? `\n\n${sig}` : "";

  if (!mail || mode === "new") {
    return { ...base, subject: "", body: newSigned };
  }
  // 설정에서 "답장·전달에도 서명 넣기"를 끄면 답장·전달에는 서명을 넣지 않는다.
  const signed = account.signReplies ? newSigned : "";

  if (mode === "forward") {
    const info = [
      "---------- 전달된 메일 ----------",
      `보낸사람: ${senderOf(mail)}`,
      `날짜: ${mail.fullTime}`,
      `제목: ${mail.subject}`,
      `받는사람: ${mail.to}`,
    ].join("\n");
    return {
      ...base,
      subject: withPrefix(mail.subject, "Fwd", FORWARD_PREFIX),
      // 전달은 `>` 없이 원문을 그대로 싣는다. 원문 속 깊은 인용만 접는다.
      body: `${signed}\n\n${info}\n\n${foldDeepQuotes(plainBody(mail))}`,
    };
  }

  const to = [senderOf(mail)];
  const extra = mode === "replyAll" ? othersOf(mail, account.email, [mail.senderEmail]) : [];
  return {
    ...base,
    to: [...to, ...extra],
    subject: withPrefix(mail.subject, "Re", REPLY_PREFIX),
    // 인용은 본문에 섞지 않고 따로 둔다. 보낼 때 `> `가 붙으므로 원문 인용은 한 단계 덜 남긴다.
    body: signed,
    quoteHeader: quoteHeaderOf(mail),
    quoteText: foldDeepQuotes(plainBody(mail), MAX_QUOTE_DEPTH - 1),
  };
}

/** 글자·구분 기호로 이어 붙인 주소 입력을 주소 목록으로 나눈다. */
export function splitAddresses(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 보내기 전에 걸러낼 만큼만 확인한다. 정확한 검증은 서버 쪽에서 한다. */
export function isValidAddress(raw: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(parseRecipient(raw).email);
}

/** 사용자가 내용을 쓴 적이 있는지. 처음 채워 둔 서명·인용만 있으면 빈 메일로 본다. */
export function isEmptyDraft(
  fields: Pick<DraftFields, "to" | "cc" | "bcc" | "subject" | "body">,
  seed: Pick<DraftFields, "subject" | "body">,
  attachmentCount: number,
): boolean {
  return (
    fields.to.length === 0 &&
    fields.cc.length === 0 &&
    fields.bcc.length === 0 &&
    attachmentCount === 0 &&
    fields.subject.trim() === seed.subject.trim() &&
    fields.body.trim() === seed.body.trim()
  );
}
