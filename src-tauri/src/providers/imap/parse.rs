//! 서버에서 받은 RFC 5322 원문을 `RemoteMessage`로 바꾼다. 네트워크와 무관한 순수 함수.

use mail_parser::{Address, Message, MessageParser, MessagePart, MimeHeaders};

use super::html_text::html_to_text;
use crate::providers::{RemoteAttachment, RemoteInlineImage, RemoteMessage};

/// 이보다 큰 인라인 이미지는 저장하지 않는다(DB 크기 보호).
const MAX_INLINE_IMAGE: usize = 5 * 1024 * 1024;

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

    let html = parsed.as_ref().and_then(html_body);

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
        dedupe_key: None,
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
            .map(|m| plain_body(m, html.as_deref()))
            .unwrap_or_default(),
        html: html.clone(),
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
                    .filter(|part| inline_image(part, html.as_deref()).is_none())
                    .map(|part| RemoteAttachment {
                        name: part.attachment_name().unwrap_or("첨부파일").to_string(),
                        size: part.len() as u64,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        inline_images: parsed
            .as_ref()
            .map(|m| {
                m.attachments()
                    .filter_map(|part| inline_image(part, html.as_deref()))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// 미리보기·검색용 텍스트. HTML이 있으면 거기서 뽑는다. 서버가 만든 text/plain 대안에는
/// 주석·조건부 주석이 그대로 남아 있는 경우가 있어(네이버 등) 믿지 않는다.
fn plain_body(m: &Message, html: Option<&str>) -> String {
    if let Some(html) = html {
        return html_to_text(html);
    }
    m.text_part(0)
        .and_then(|part| part.text_contents())
        .map(|t| t.replace("\r\n", "\n"))
        .unwrap_or_default()
}

/// 실제 text/html 본문. text/plain만 있는 메일은 `None`.
fn html_body(m: &Message) -> Option<String> {
    let part = m.html_part(0).filter(|p| p.is_text_html())?;
    part.text_contents()
        .filter(|h| !h.trim().is_empty())
        .map(str::to_string)
}

/// HTML이 `cid:`로 가리키는 이미지 파트면 인라인 이미지로 돌려준다.
fn inline_image(part: &MessagePart, html: Option<&str>) -> Option<RemoteInlineImage> {
    let html = html?.to_ascii_lowercase();
    let content_id = part.content_id()?.trim_matches(['<', '>']).to_string();
    let ct = part.content_type()?;
    if !ct.ctype().eq_ignore_ascii_case("image") || part.len() > MAX_INLINE_IMAGE {
        return None;
    }
    if !html.contains(&format!("cid:{}", content_id.to_ascii_lowercase())) {
        return None;
    }
    let subtype = ct.subtype().unwrap_or("png").to_ascii_lowercase();
    Some(RemoteInlineImage {
        content_id,
        mime: format!("image/{subtype}"),
        data: part.contents().to_vec(),
    })
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

    /// 실계정 테스트에서 미리보기가 깨졌던 모양: Outlook 조건부 주석 + style + 프리헤더 여백.
    const MARKETING_HTML: &str = "<!DOCTYPE html><html><head><title>뉴스레터</title>\
        <style>.a { color: red }</style>\
        <!--[if mso]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]-->\
        </head><body><div style=\"display:none\">이번 주 소식&nbsp;&zwnj;&nbsp;&zwnj;</div>\
        <!--[if mso]><table><tr><td>MSO</td></tr></table><![endif]-->\
        <script>track()</script><p>안녕하세요, <b>10월</b> 소식입니다.</p></body></html>";

    #[test]
    fn html만_있는_메일의_본문_텍스트에_주석과_스타일이_섞이지_않는다() {
        let raw = format!(
            "From: a@b.com\r\nSubject: s\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n{MARKETING_HTML}"
        );
        let m = parse_message(&fetch(&raw));
        assert_eq!(m.body, "이번 주 소식\n\n안녕하세요, 10월 소식입니다.");
        for junk in ["mso", "color", "track", "뉴스레터", "<", "xml"] {
            assert!(!m.body.contains(junk), "{junk} 섞임: {}", m.body);
        }
        assert!(
            m.html.unwrap().contains("<script>"),
            "원문 HTML은 정제 없이 보관한다"
        );
    }

    #[test]
    fn html이_있으면_서버가_만든_텍스트_대안이_아니라_html에서_본문을_뽑는다() {
        // 네이버 메일: text/plain 대안에 주석이 그대로 남아 있다.
        let raw = "From: a@b.com\r\nSubject: s\r\nMIME-Version: 1.0\r\n\
                   Content-Type: multipart/alternative; boundary=XX\r\n\r\n\
                   --XX\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n\
                   <!-- 아웃룩용 max-width 핵 --> <!--[if (gte mso 9)|(IE)]> 일반 텍스트\r\n\
                   --XX\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n\
                   <!-- 아웃룩용 max-width 핵 --><!--[if (gte mso 9)|(IE)]><table><tr><td><![endif]-->\
                   <p>HTML 본문</p>\r\n--XX--\r\n";
        let m = parse_message(&fetch(raw));
        assert_eq!(m.body, "HTML 본문");
        assert!(m.html.unwrap().contains("<p>HTML 본문</p>"));
    }

    #[test]
    fn euc_kr_메일의_헤더와_본문을_해석한다() {
        // "제목"(인코딩된 단어)과 "안녕"(EUC-KR 원시 바이트)
        let mut raw = b"From: =?EUC-KR?B?waa48Q==?= <a@gabia.com>\r\n\
                        Subject: =?EUC-KR?B?waa48Q==?=\r\n\
                        Content-Type: text/plain; charset=euc-kr\r\n\r\n"
            .to_vec();
        raw.extend_from_slice(&[0xBE, 0xC8, 0xB3, 0xE7]);
        let m = parse_message(&FetchedMessage {
            uid: 1,
            raw: &raw,
            unread: true,
            starred: false,
            internal_date: 0,
        });
        assert_eq!(m.sender, "제목");
        assert_eq!(m.subject, "제목");
        assert_eq!(m.body, "안녕");
    }

    #[test]
    fn 텍스트_메일은_html이_없다() {
        let m = parse_message(&fetch("From: a@b.com\r\nSubject: s\r\n\r\n그냥 글"));
        assert_eq!(m.html, None);
        assert!(m.body.contains("그냥 글"));
    }

    #[test]
    fn cid_인라인_이미지는_첨부가_아니라_인라인_이미지로_분리한다() {
        let raw = "From: a@b.com\r\nSubject: s\r\nMIME-Version: 1.0\r\n\
                   Content-Type: multipart/related; boundary=XX\r\n\r\n\
                   --XX\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n\
                   <p>로고</p><img src=\"cid:Logo@Mail\">\r\n\
                   --XX\r\nContent-Type: image/png; name=\"logo.png\"\r\n\
                   Content-ID: <logo@mail>\r\nContent-Disposition: inline; filename=\"logo.png\"\r\n\
                   Content-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n\
                   --XX\r\nContent-Type: image/png; name=\"unused.png\"\r\n\
                   Content-ID: <unused@mail>\r\nContent-Disposition: inline\r\n\
                   Content-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--XX--\r\n";
        let m = parse_message(&fetch(raw));
        assert_eq!(m.inline_images.len(), 1);
        assert_eq!(m.inline_images[0].content_id, "logo@mail");
        assert_eq!(m.inline_images[0].mime, "image/png");
        assert_eq!(m.inline_images[0].data, b"Hello");
        // 본문이 가리키지 않는 이미지는 일반 첨부로 남는다.
        assert_eq!(m.attachments.len(), 1);
        assert_eq!(m.attachments[0].name, "unused.png");
    }

    #[test]
    fn 깨진_입력도_패닉하지_않는다() {
        let m = parse_message(&fetch(""));
        assert_eq!(m.remote_id, "7");
    }
}
