import { describe, expect, it } from "vitest";
import type { Account, MailDetail } from "../../lib/ipc";
import {
  isEmptyDraft,
  isValidAddress,
  signatureBlock,
  splitAddresses,
  startDraft,
  swapSignature,
} from "./compose";

const account: Account = {
  id: "a1",
  name: "개인 Gmail",
  email: "me@gmail.com",
  provider: "gmail",
  colorIndex: 1,
  unread: 0,
  initial: "개",
  signature: "박준호 드림",
};

const mail: MailDetail = {
  id: "a1-inbox-1",
  accountId: "a1",
  folderId: "a1-inbox",
  sender: "김도윤",
  senderEmail: "doyun@gmail.com",
  subject: "Re: 제주 여행",
  preview: "",
  time: "",
  unread: false,
  starred: false,
  hasAttachment: true,
  to: "me@gmail.com, seoyeon@naver.com, doyun@gmail.com",
  body: ["준호야,\n항공권 끝!", "렌터카도 부탁해"],
  html: undefined,
  attachments: [],
  earlier: [],
  fullTime: "어제 오전 9:12",
};

describe("서명", () => {
  it("서명이 없으면 본문도 비어 있다", () => {
    expect(startDraft({ mode: "new", account: { ...account, signature: "" } }).body).toBe("");
    expect(signatureBlock("  ")).toBe("");
  });

  it("새 메일 본문 끝에 서명 구분선과 함께 들어간다", () => {
    expect(startDraft({ mode: "new", account }).body).toBe("\n\n-- \n박준호 드림");
  });

  it("계정을 바꾸면 서명도 바뀌고, 직접 고친 서명은 건드리지 않는다", () => {
    const body = "안녕\n\n-- \n박준호 드림";
    expect(swapSignature(body, "박준호 드림", "Junho")).toBe("안녕\n\n-- \nJunho");
    expect(swapSignature(body, "박준호 드림", "")).toBe("안녕");
    expect(swapSignature("안녕\n\n-- \n내가 고침", "박준호 드림", "Junho")).toBe(
      "안녕\n\n-- \n내가 고침",
    );
    expect(swapSignature("안녕", "", "Junho")).toBe("안녕\n\n-- \nJunho");
  });
});

describe("답장·전달", () => {
  it("답장: 보낸 사람에게, 제목은 Re: 한 번만, 원문은 > 로 인용한다", () => {
    const d = startDraft({ mode: "reply", account, mail });
    expect(d.to).toEqual(["김도윤 <doyun@gmail.com>"]);
    expect(d.subject).toBe("Re: 제주 여행");
    expect(d.body).toBe(
      "\n\n-- \n박준호 드림\n\n어제 오전 9:12에 김도윤 <doyun@gmail.com>님이 작성:\n" +
        "> 준호야,\n> 항공권 끝!\n>\n> 렌터카도 부탁해",
    );
    expect(d.accountId).toBe("a1");
  });

  it("전체 답장: 내 주소와 보낸 사람 중복을 뺀 나머지 받는사람이 따라온다", () => {
    const d = startDraft({ mode: "replyAll", account, mail });
    expect(d.to).toEqual(["김도윤 <doyun@gmail.com>", "seoyeon@naver.com"]);
  });

  it("보낸 사람 이름이 주소와 같으면 주소만 쓴다", () => {
    const d = startDraft({
      mode: "reply",
      account,
      mail: { ...mail, sender: "a@b.com", senderEmail: "a@b.com" },
    });
    expect(d.to).toEqual(["a@b.com"]);
  });

  it("전달: 받는사람은 비우고 제목에 Fwd:, 원문 정보를 본문에 싣는다", () => {
    const d = startDraft({ mode: "forward", account, mail: { ...mail, subject: "Fwd: 견적" } });
    expect(d.to).toEqual([]);
    expect(d.subject).toBe("Fwd: 견적");
    expect(d.body).toContain("---------- 전달된 메일 ----------");
    expect(d.body).toContain("보낸사람: 김도윤 <doyun@gmail.com>");
    expect(d.body).toContain("준호야,\n항공권 끝!\n\n렌터카도 부탁해");
  });
});

describe("주소", () => {
  it("쉼표·세미콜론·줄바꿈으로 나눈다", () => {
    expect(splitAddresses("a@b.com, c@d.com;\n 김 <e@f.kr> ,")).toEqual([
      "a@b.com",
      "c@d.com",
      "김 <e@f.kr>",
    ]);
  });

  it("주소 모양만 확인한다", () => {
    expect(isValidAddress("a@b.com")).toBe(true);
    expect(isValidAddress("김도윤 <doyun@gmail.com>")).toBe(true);
    expect(isValidAddress("김도윤")).toBe(false);
    expect(isValidAddress("a@b")).toBe(false);
  });
});

describe("빈 메일 판단", () => {
  const seed = { subject: "Re: x", body: "\n\n인용" };
  const same = { to: [], cc: [], bcc: [], ...seed };

  it("처음 채운 내용 그대로면 빈 메일이다", () => {
    expect(isEmptyDraft(same, seed, 0)).toBe(true);
  });

  it("받는사람·본문 수정·첨부 중 하나라도 있으면 아니다", () => {
    expect(isEmptyDraft({ ...same, to: ["a@b.com"] }, seed, 0)).toBe(false);
    expect(isEmptyDraft({ ...same, body: "안녕\n\n인용" }, seed, 0)).toBe(false);
    expect(isEmptyDraft(same, seed, 1)).toBe(false);
  });
});
