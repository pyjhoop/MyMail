// 작성기의 순수 로직: 새 메일·답장·전달 초안 만들기, 서명 넣기·바꾸기, 주소 다루기.
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

/** 답장·전달에 인용하는 원문. 줄마다 `> `를 붙인다. */
function quoted(mail: MailDetail): string {
  return mail.body
    .join("\n\n")
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
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
  const base = { id: newDraftId(), accountId: account.id, to: [], cc: [], bcc: [] };
  const sig = signatureBlock(account.signature);
  const signed = sig ? `\n\n${sig}` : "";

  if (!mail || mode === "new") {
    return { ...base, subject: "", body: signed };
  }

  const header = `${mail.fullTime}에 ${senderOf(mail)}님이 작성:`;
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
      body: `${signed}\n\n${info}\n\n${mail.body.join("\n\n")}`,
    };
  }

  const to = [senderOf(mail)];
  const extra = mode === "replyAll" ? othersOf(mail, account.email, [mail.senderEmail]) : [];
  return {
    ...base,
    to: [...to, ...extra],
    subject: withPrefix(mail.subject, "Re", REPLY_PREFIX),
    body: `${signed}\n\n${header}\n${quoted(mail)}`,
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
