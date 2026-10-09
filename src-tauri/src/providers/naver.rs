//! 네이버 메일 설정. IMAP 공통 구현에 값만 넘긴다.

use super::imap::ImapConfig;
use super::FolderKind;

pub const CONFIG: ImapConfig = ImapConfig {
    host: "imap.naver.com",
    port: 993,
    auth_hint: "아이디·비밀번호가 맞는지, IMAP 사용이 켜져 있는지 확인해 주세요. 2단계 인증을 쓰고 있다면 일반 비밀번호 대신 애플리케이션 비밀번호가 필요해요.",
    name_kinds: &[
        ("sent messages", FolderKind::Sent),
        ("보낸메일함", FolderKind::Sent),
        ("보낸메일", FolderKind::Sent),
        ("drafts", FolderKind::Drafts),
        ("임시보관함", FolderKind::Drafts),
        ("임시보관", FolderKind::Drafts),
        ("junk", FolderKind::Spam),
        ("스팸메일함", FolderKind::Spam),
        ("스팸메일", FolderKind::Spam),
        ("deleted messages", FolderKind::Trash),
        ("trash", FolderKind::Trash),
        ("휴지통", FolderKind::Trash),
    ],
    hidden_special_use: &[],
    gmail_extensions: false,
};
