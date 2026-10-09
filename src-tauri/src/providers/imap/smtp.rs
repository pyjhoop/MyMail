//! SMTP 발송. 메일을 MIME으로 만들어 서비스의 SMTP 서버(암묵적 TLS)로 보낸다.

use std::time::Duration;

use lettre::address::Address;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Message, SmtpTransport, Transport};

use super::ImapConfig;
use crate::providers::{OutgoingMail, ProviderError};

const SMTP_TIMEOUT: Duration = Duration::from_secs(60);

/// `이름 <주소>` 또는 `주소`를 메일 주소로 바꾼다.
fn mailbox(raw: &str) -> Result<Mailbox, ProviderError> {
    let invalid = || ProviderError::Rejected(format!("올바르지 않은 메일 주소예요: {raw}"));
    let raw = raw.trim();
    let (name, email) = match (raw.rfind('<'), raw.rfind('>')) {
        (Some(open), Some(close)) if open < close => (
            Some(raw[..open].trim().trim_matches('"').trim().to_string()).filter(|n| !n.is_empty()),
            raw[open + 1..close].trim(),
        ),
        _ => (None, raw),
    };
    let address: Address = email.parse().map_err(|_| invalid())?;
    Ok(Mailbox::new(name, address))
}

fn build(mail: &OutgoingMail) -> Result<Message, ProviderError> {
    let mut builder = Message::builder()
        .from(Mailbox::new(
            Some(mail.from_name.clone()).filter(|n| !n.is_empty()),
            mail.from_email.parse().map_err(|_| {
                ProviderError::Rejected("보내는 계정 주소가 올바르지 않아요".into())
            })?,
        ))
        .subject(mail.subject.clone());
    for to in &mail.to {
        builder = builder.to(mailbox(to)?);
    }
    for cc in &mail.cc {
        builder = builder.cc(mailbox(cc)?);
    }
    for bcc in &mail.bcc {
        builder = builder.bcc(mailbox(bcc)?);
    }

    let text = SinglePart::plain(mail.body.clone());
    let built = if mail.attachments.is_empty() {
        builder.singlepart(text)
    } else {
        let mut parts = MultiPart::mixed().singlepart(text);
        for a in &mail.attachments {
            let content_type = ContentType::parse(&a.mime).unwrap_or_else(|_| {
                ContentType::parse("application/octet-stream").unwrap_or(ContentType::TEXT_PLAIN)
            });
            parts = parts
                .singlepart(Attachment::new(a.name.clone()).body(a.data.clone(), content_type));
        }
        builder.multipart(parts)
    };
    built.map_err(|e| ProviderError::Rejected(format!("메일을 만들지 못했어요: {e}")))
}

pub fn send(
    config: &ImapConfig,
    email: &str,
    password: &str,
    mail: &OutgoingMail,
) -> Result<(), ProviderError> {
    let message = build(mail)?;
    let transport = SmtpTransport::relay(config.smtp_host)
        .map_err(|e| ProviderError::Network(e.to_string()))?
        .port(config.smtp_port)
        .credentials(Credentials::new(email.to_string(), password.to_string()))
        .timeout(Some(SMTP_TIMEOUT))
        .build();
    transport.send(&message).map(|_| ()).map_err(|e| {
        let code = e.status().map(|c| c.to_string());
        match code.as_deref() {
            // 530 인증 필요, 534 더 강한 인증 필요, 535 인증 실패
            Some("530" | "534" | "535") => ProviderError::Auth(config.auth_hint.into()),
            _ if e.is_permanent() => ProviderError::Rejected(e.to_string()),
            _ => ProviderError::Network(e.to_string()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::OutgoingAttachment;

    fn sample() -> OutgoingMail {
        OutgoingMail {
            from_name: "박준호".into(),
            from_email: "me@gmail.com".into(),
            to: vec!["김도윤 <doyun@gmail.com>".into(), "b@naver.com".into()],
            cc: vec!["c@naver.com".into()],
            bcc: vec!["d@naver.com".into()],
            subject: "안녕하세요".into(),
            body: "본문입니다".into(),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn 이름과_주소를_나눠_읽는다() {
        let m = mailbox("김도윤 <doyun@gmail.com>").unwrap();
        assert_eq!(m.email.to_string(), "doyun@gmail.com");
        assert_eq!(m.name.as_deref(), Some("김도윤"));
        let m = mailbox("  a@b.com ").unwrap();
        assert_eq!(m.name, None);
    }

    #[test]
    fn 잘못된_주소는_거절한다() {
        assert!(matches!(
            mailbox("not-an-address"),
            Err(ProviderError::Rejected(_))
        ));
        assert!(matches!(
            mailbox("이름 <>"),
            Err(ProviderError::Rejected(_))
        ));
    }

    #[test]
    fn 받는사람_참조_숨은참조가_메일에_담긴다() {
        let raw = String::from_utf8(build(&sample()).unwrap().formatted()).unwrap();
        assert!(raw.contains("doyun@gmail.com"));
        assert!(raw.contains("Cc: c@naver.com"));
        // 숨은참조는 헤더에 남기지 않는다.
        assert!(!raw.contains("d@naver.com"));
    }

    #[test]
    fn 첨부가_있으면_multipart로_만든다() {
        let mut mail = sample();
        mail.attachments.push(OutgoingAttachment {
            name: "견적.pdf".into(),
            mime: "application/pdf".into(),
            data: b"%PDF-1.4".to_vec(),
        });
        let raw = String::from_utf8(build(&mail).unwrap().formatted()).unwrap();
        assert!(raw.contains("multipart/mixed"));
        assert!(raw.contains("application/pdf"));
    }
}
