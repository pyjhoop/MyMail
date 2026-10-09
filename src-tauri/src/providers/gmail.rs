//! Gmail 설정. IMAP 공통 구현에 값만 넘기고, Gmail 전용 확장(X-GM-*)은 켜기만 한다.

use super::imap::ImapConfig;

pub const CONFIG: ImapConfig = ImapConfig {
    host: "imap.gmail.com",
    port: 993,
    smtp_host: "smtp.gmail.com",
    smtp_port: 465,
    max_message_bytes: 25 * 1024 * 1024,
    auth_hint: "Google 계정에서 2단계 인증을 켜고 앱 비밀번호(16자리)를 만들어 입력해 주세요. 평소 쓰는 Google 비밀번호로는 로그인할 수 없어요.",
    // 폴더 종류는 SPECIAL-USE(\Sent, \Drafts, \Junk, \Trash, \All)로 식별한다.
    name_kinds: &[],
    // [Gmail]/별표편지함(\Flagged)·중요(\Important)는 다른 메일의 사본이라 목록에서 뺀다.
    hidden_special_use: &[r"\flagged", r"\important"],
    gmail_extensions: true,
};
