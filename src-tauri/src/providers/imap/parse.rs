//! 서버에서 받은 RFC 5322 원문을 `RemoteMessage`로 바꾼다. 네트워크와 무관한 순수 함수.

use mail_parser::{Address, MessageParser, MimeHeaders};

use crate::providers::{RemoteAttachment, RemoteMessage};

/// IMAP FETCH로 받은 값 중 파싱에 필요한 것.
pub struct FetchedMessage<'a> {
    pub uid: u32,
    pub raw: &'a [u8],
    pub unread: bool,
    pub starred: bool,
    /// 서버가 기록한 수신 시각(유닉스 초). `Date` 헤더가 없거나 깨졌을 때 쓴다.
    pub internal_date: i64,
}

pub fn parse_message(fetched: &FetchedMessage) -> RemoteMessage {
    let parsed = MessageParser::default().parse(fetched.raw);

    let (sender, sender_email) = parsed
        .as_ref()
        .and_then(|m| m.from())
        .and_then(|a| a.first())
        .map(|a| {
            let email = a.address().unwrap_or_default().to_string();
            let name = a.name().filter(|n| !n.is_empty()).unwrap_or(&email);
            (name.to_string(), email.clone())
        })
        .unwrap_or_default();

    RemoteMessage {
        remote_id: fetched.uid.to_string(),
        thread_id: None,
        sender,
        sender_email,
        recipients: parsed
            .as_ref()
            .and_then(|m| m.to())
            .map(join_addresses)
            .unwrap_or_default(),
        subject: parsed
            .as_ref()
            .and_then(|m| m.subject())
            .unwrap_or("(제목 없음)")
            .to_string(),
        body: parsed
            .as_ref()
            .and_then(|m| m.body_text(0))
            .map(|b| b.replace("\r\n", "\n"))
            .unwrap_or_default(),
        received_at: parsed
            .as_ref()
            .and_then(|m| m.date())
            .map_or(fetched.internal_date, |d| d.to_timestamp()),
        unread: fetched.unread,
        starred: fetched.starred,
        label: None,
        attachments: parsed
            .as_ref()
            .map(|m| {
                m.attachments()
                    .map(|part| RemoteAttachment {
                        name: part.attachment_name().unwrap_or("첨부파일").to_string(),
                        size: part.len() as u64,
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn join_addresses(addresses: &Address) -> String {
    addresses
        .iter()
        .filter_map(|a| a.address())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fetch(raw: &str) -> FetchedMessage<'_> {
        FetchedMessage {
            uid: 7,
            raw: raw.as_bytes(),
            unread: true,
            starred: false,
            internal_date: 1_760_000_000,
        }
    }

    #[test]
    fn 한글_헤더와_본문을_해석한다() {
        let raw = "From: =?UTF-8?B?6rmA64+E7Jyk?= <doyun@gmail.com>\r\n\
                   To: me@naver.com, you@naver.com\r\n\
                   Subject: =?UTF-8?B?7KCc7KO8IOyXrO2WiQ==?=\r\n\
                   Date: Fri, 09 Oct 2026 09:12:00 +0900\r\n\
                   Content-Type: text/plain; charset=UTF-8\r\n\r\n안녕하세요\r\n";
        let m = parse_message(&fetch(raw));
        assert_eq!(m.sender, "김도윤");
        assert_eq!(m.sender_email, "doyun@gmail.com");
        assert_eq!(m.subject, "제주 여행");
        assert_eq!(m.recipients, "me@naver.com, you@naver.com");
        assert_eq!(m.received_at, 1_791_504_720);
        assert!(m.body.contains("안녕하세요"));
        assert_eq!(m.remote_id, "7");
    }

    #[test]
    fn 이름이_없으면_주소를_보낸이로_쓴다() {
        let m = parse_message(&fetch("From: a@b.com\r\nSubject: hi\r\n\r\nbody"));
        assert_eq!(m.sender, "a@b.com");
    }

    #[test]
    fn 날짜_헤더가_없으면_수신_시각을_쓴다() {
        let m = parse_message(&fetch("From: a@b.com\r\n\r\nbody"));
        assert_eq!(m.received_at, 1_760_000_000);
        assert_eq!(m.subject, "(제목 없음)");
    }

    #[test]
    fn 첨부를_센다() {
        let raw = "From: a@b.com\r\nSubject: f\r\nMIME-Version: 1.0\r\n\
                   Content-Type: multipart/mixed; boundary=XX\r\n\r\n\
                   --XX\r\nContent-Type: text/plain\r\n\r\nhello\r\n\
                   --XX\r\nContent-Type: application/pdf; name=\"a.pdf\"\r\n\
                   Content-Disposition: attachment; filename=\"a.pdf\"\r\n\
                   Content-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--XX--\r\n";
        let m = parse_message(&fetch(raw));
        assert_eq!(m.attachments.len(), 1);
        assert_eq!(m.attachments[0].name, "a.pdf");
        assert_eq!(m.attachments[0].size, 5);
    }

    #[test]
    fn 깨진_입력도_패닉하지_않는다() {
        let m = parse_message(&fetch(""));
        assert_eq!(m.remote_id, "7");
    }
}
