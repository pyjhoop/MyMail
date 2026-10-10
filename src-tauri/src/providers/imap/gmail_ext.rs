//! Gmail IMAP 확장(X-GM-MSGID·X-GM-THRID·X-GM-LABELS) 응답 해석. 네트워크와 무관한 순수 함수.
//! `imap` 크레이트의 파서가 이 속성을 몰라서, 별도 FETCH의 원문 응답을 직접 읽는다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};

use super::utf7;

/// 서버가 알려 주는 시스템 라벨의 접두어(`\Inbox`, `\Sent` 등). 사용자 라벨이 아니다.
const SYSTEM_LABEL_PREFIX: char = '\\';

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct GmailAttrs {
    pub msgid: Option<String>,
    pub thrid: Option<String>,
    /// 사용자가 만든 라벨만 (시스템 라벨 제외, UTF-7 디코딩 완료)
    pub labels: Vec<String>,
}

/// `UID FETCH ... (UID X-GM-MSGID X-GM-THRID X-GM-LABELS)` 응답을 UID별로 풀어낸다.
pub fn parse_attrs(raw: &[u8]) -> HashMap<u32, GmailAttrs> {
    let text = String::from_utf8_lossy(raw);
    let mut out = HashMap::new();
    for line in text.lines() {
        if !line.starts_with("* ") || !line.contains("FETCH (") {
            continue;
        }
        // 라벨 이름 안에 "UID" 같은 글자가 있어도 속지 않도록 라벨 목록을 먼저 떼어 낸다.
        let (labels, rest) = split_labels(line);
        let Some(uid) = number_after(&rest, "UID ").and_then(|n| n.parse().ok()) else {
            continue;
        };
        out.insert(
            uid,
            GmailAttrs {
                msgid: number_after(&rest, "X-GM-MSGID "),
                thrid: number_after(&rest, "X-GM-THRID "),
                labels,
            },
        );
    }
    out
}

fn number_after(line: &str, key: &str) -> Option<String> {
    let start = line.find(key)? + key.len();
    let digits: String = line[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    (!digits.is_empty()).then_some(digits)
}

/// `X-GM-LABELS (...)` 부분을 파싱하고, 그 부분을 뺀 나머지 줄을 함께 돌려준다.
fn split_labels(line: &str) -> (Vec<String>, String) {
    const KEY: &str = "X-GM-LABELS (";
    let Some(pos) = line.find(KEY) else {
        return (Vec::new(), line.to_string());
    };
    let body_start = pos + KEY.len();
    let mut labels = Vec::new();
    let mut chars = line[body_start..].char_indices().peekable();
    let mut end = line.len();
    while let Some((i, c)) = chars.next() {
        match c {
            ')' => {
                end = body_start + i + 1;
                break;
            }
            '"' => {
                let mut label = String::new();
                while let Some((_, c)) = chars.next() {
                    match c {
                        '\\' => {
                            if let Some((_, escaped)) = chars.next() {
                                label.push(escaped);
                            }
                        }
                        '"' => break,
                        other => label.push(other),
                    }
                }
                push_label(&mut labels, &label);
            }
            c if c.is_whitespace() => {}
            _ => {
                let mut atom = String::from(c);
                while let Some(&(_, next)) = chars.peek() {
                    if next.is_whitespace() || next == ')' {
                        break;
                    }
                    atom.push(next);
                    chars.next();
                }
                push_label(&mut labels, &atom);
            }
        }
    }
    let rest = format!("{}{}", &line[..pos], &line[end..]);
    (labels, rest)
}

fn push_label(labels: &mut Vec<String>, raw: &str) {
    // 따옴표 없는 `\Inbox`는 시스템 라벨, 따옴표 안의 `\\Inbox`도 이스케이프를 풀면 같다.
    if raw.is_empty() || raw.starts_with(SYSTEM_LABEL_PREFIX) {
        return;
    }
    labels.push(utf7::decode(raw));
}

/// 원문 명령 실패. 로그인 거부와 그 밖의 오류만 구분한다.
#[derive(Debug, PartialEq, Eq)]
pub enum RawError {
    LoginRejected,
    Failed(String),
}

impl From<std::io::Error> for RawError {
    fn from(e: std::io::Error) -> Self {
        Self::Failed(e.to_string())
    }
}

/// UID 묶음 하나당 한 번의 FETCH. 명령 줄이 너무 길어지지 않게 나눈다.
const UID_CHUNK: usize = 500;

/// `imap` 크레이트를 거치지 않고 직접 IMAP 명령을 보내 Gmail 확장 속성을 가져온다.
/// 크레이트는 응답의 모든 줄을 자체 파서로 검사하는데, 이 파서가 X-GM-* 속성을 몰라서
/// "Unable to parse status response"로 실패한다. 여기서는 로그인 → EXAMINE → UID FETCH만 한다.
pub fn fetch_attrs<S: Read + Write>(
    stream: S,
    email: &str,
    password: &str,
    folder: &str,
    uids: &[u32],
) -> Result<HashMap<u32, GmailAttrs>, RawError> {
    let mut conn = RawConn {
        reader: BufReader::new(stream),
        next_tag: 0,
    };
    let mut greeting = Vec::new();
    conn.reader.read_until(b'\n', &mut greeting)?;

    conn.command(&format!("LOGIN {} {}", quote(email), quote(password)))
        .map_err(|e| match e {
            RawError::Failed(m) if m.starts_with("NO") || m.starts_with("BAD") => {
                RawError::LoginRejected
            }
            other => other,
        })?;
    conn.command(&format!("EXAMINE {}", quote(folder)))?;

    let mut attrs = HashMap::new();
    for chunk in uids.chunks(UID_CHUNK) {
        let set = chunk
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let raw = conn.command(&format!(
            "UID FETCH {set} (UID X-GM-MSGID X-GM-THRID X-GM-LABELS)"
        ))?;
        attrs.extend(parse_attrs(&raw));
    }
    let _ = conn.command("LOGOUT");
    Ok(attrs)
}

/// 메일 한 통에 라벨을 붙이거나 뗀다(`UID STORE ± X-GM-LABELS`). 응답에 X-GM-* 속성이 섞여 와서
/// `imap` 크레이트 파서가 실패하므로 `fetch_attrs`처럼 직접 명령을 보낸다.
pub fn change_label<S: Read + Write>(
    stream: S,
    email: &str,
    password: &str,
    folder: &str,
    uid: u32,
    label: &str,
    add: bool,
) -> Result<(), RawError> {
    let mut conn = RawConn {
        reader: BufReader::new(stream),
        next_tag: 0,
    };
    let mut greeting = Vec::new();
    conn.reader.read_until(b'\n', &mut greeting)?;
    conn.command(&format!("LOGIN {} {}", quote(email), quote(password)))
        .map_err(|e| match e {
            RawError::Failed(m) if m.starts_with("NO") || m.starts_with("BAD") => {
                RawError::LoginRejected
            }
            other => other,
        })?;
    conn.command(&format!("SELECT {}", quote(folder)))?;
    let sign = if add { '+' } else { '-' };
    conn.command(&format!(
        "UID STORE {uid} {sign}X-GM-LABELS ({})",
        quote(&utf7::encode(label))
    ))?;
    let _ = conn.command("LOGOUT");
    Ok(())
}

struct RawConn<S: Read + Write> {
    reader: BufReader<S>,
    next_tag: u32,
}

impl<S: Read + Write> RawConn<S> {
    /// 명령을 보내고 태그가 붙은 완료 응답까지 읽는다. 그 앞의 untagged 응답을 돌려준다.
    fn command(&mut self, command: &str) -> Result<Vec<u8>, RawError> {
        self.next_tag += 1;
        let tag = format!("g{}", self.next_tag);
        let stream = self.reader.get_mut();
        stream.write_all(format!("{tag} {command}\r\n").as_bytes())?;
        stream.flush()?;

        let mut data = Vec::new();
        loop {
            let start = data.len();
            if self.reader.read_until(b'\n', &mut data)? == 0 {
                return Err(RawError::Failed("서버가 연결을 끊었어요".into()));
            }
            let line = String::from_utf8_lossy(&data[start..]);
            if let Some(status) = line.strip_prefix(&format!("{tag} ")) {
                if status.starts_with("OK") {
                    data.truncate(start);
                    return Ok(data);
                }
                return Err(RawError::Failed(status.trim_end().to_string()));
            }
        }
    }
}

/// IMAP quoted string. 따옴표와 역슬래시만 이스케이프한다.
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 메시지_id_스레드_id_라벨을_읽는다() {
        let raw = b"* 3 FETCH (X-GM-THRID 1700000000000001 X-GM-MSGID 1700000000000002 \
X-GM-LABELS (\\Inbox \\Important Work \"Project X\") UID 42)\r\nA1 OK done\r\n";
        let attrs = parse_attrs(raw);
        let a = &attrs[&42];
        assert_eq!(a.msgid.as_deref(), Some("1700000000000002"));
        assert_eq!(a.thrid.as_deref(), Some("1700000000000001"));
        assert_eq!(a.labels, vec!["Work", "Project X"]);
    }

    #[test]
    fn 한글_라벨은_utf7을_디코딩하고_속성_순서가_달라도_읽는다() {
        let raw =
            b"* 1 FETCH (UID 7 X-GM-MSGID 55 X-GM-LABELS (\"&vPSwuLpUx3w-\") X-GM-THRID 66)\r\n";
        let a = &parse_attrs(raw)[&7];
        assert_eq!(a.labels, vec!["보낸메일"]);
        assert_eq!(a.msgid.as_deref(), Some("55"));
        assert_eq!(a.thrid.as_deref(), Some("66"));
    }

    #[test]
    fn 라벨_이름에_uid가_있어도_속지_않는다() {
        let raw = b"* 1 FETCH (X-GM-LABELS (\"UID 999\") UID 7 X-GM-MSGID 5 X-GM-THRID 6)\r\n";
        let attrs = parse_attrs(raw);
        assert!(attrs.contains_key(&7));
        assert!(!attrs.contains_key(&999));
        assert_eq!(attrs[&7].labels, vec!["UID 999"]);
    }

    #[test]
    fn 라벨이_없으면_빈_목록이다() {
        let raw = b"* 1 FETCH (UID 7 X-GM-MSGID 5 X-GM-THRID 6 X-GM-LABELS ())\r\n";
        assert!(parse_attrs(raw)[&7].labels.is_empty());
    }

    #[test]
    fn fetch_줄이_아니면_무시한다() {
        assert!(parse_attrs(b"A1 OK done\r\n* 3 EXISTS\r\n").is_empty());
    }

    /// 준비된 응답을 읽고, 보낸 내용을 모아 두는 가짜 스트림
    struct Mock {
        input: std::io::Cursor<Vec<u8>>,
        sent: std::rc::Rc<std::cell::RefCell<Vec<u8>>>,
    }
    impl Read for Mock {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(buf)
        }
    }
    impl Write for Mock {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.sent.borrow_mut().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn mock(server: &str) -> (Mock, std::rc::Rc<std::cell::RefCell<Vec<u8>>>) {
        let sent = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let m = Mock {
            input: std::io::Cursor::new(server.as_bytes().to_vec()),
            sent: sent.clone(),
        };
        (m, sent)
    }

    #[test]
    fn 직접_명령으로_확장_속성을_가져온다() {
        let (m, sent) = mock(
            "* OK ready\r\ng1 OK logged in\r\n* 3 EXISTS\r\ng2 OK [READ-ONLY] done\r\n\
* 1 FETCH (UID 7 X-GM-MSGID 55 X-GM-THRID 66 X-GM-LABELS (Work))\r\ng3 OK done\r\ng4 OK bye\r\n",
        );
        let attrs = fetch_attrs(m, "me@gmail.com", "pa\"ss", "INBOX", &[7]).unwrap();
        assert_eq!(attrs[&7].msgid.as_deref(), Some("55"));
        assert_eq!(attrs[&7].labels, vec!["Work"]);
        let sent = String::from_utf8(sent.borrow().clone()).unwrap();
        assert!(sent.contains("g1 LOGIN \"me@gmail.com\" \"pa\\\"ss\"\r\n"));
        assert!(sent.contains("g2 EXAMINE \"INBOX\"\r\n"));
        assert!(sent.contains("g3 UID FETCH 7 (UID X-GM-MSGID X-GM-THRID X-GM-LABELS)\r\n"));
    }

    #[test]
    fn 라벨을_붙이고_뗀다() {
        let (m, sent) = mock(
            "* OK ready\r\ng1 OK in\r\ng2 OK [READ-WRITE] done\r\n\
* 1 FETCH (X-GM-LABELS (Work) UID 7)\r\ng3 OK done\r\ng4 OK bye\r\n",
        );
        change_label(m, "a", "b", "INBOX", 7, "Work/Sub", true).unwrap();
        let sent = String::from_utf8(sent.borrow().clone()).unwrap();
        assert!(sent.contains("g2 SELECT \"INBOX\"\r\n"));
        assert!(sent.contains("g3 UID STORE 7 +X-GM-LABELS (\"Work/Sub\")\r\n"));
        let (m, sent) = mock("* OK ready\r\ng1 OK in\r\ng2 OK done\r\ng3 OK done\r\ng4 OK bye\r\n");
        change_label(m, "a", "b", "INBOX", 7, "여행", false).unwrap();
        let sent = String::from_utf8(sent.borrow().clone()).unwrap();
        assert!(
            sent.contains("g3 UID STORE 7 -X-GM-LABELS (\"&xezViQ-\")\r\n"),
            "{sent}"
        );
    }

    #[test]
    fn 서버가_거절하면_실패한다() {
        let (m, _) = mock("* OK ready\r\ng1 OK in\r\ng2 NO [NONEXISTENT] no such folder\r\n");
        assert!(matches!(
            change_label(m, "a", "b", "X", 1, "Work", true),
            Err(RawError::Failed(msg)) if msg.starts_with("NO")
        ));
    }

    #[test]
    fn 로그인이_거부되면_구분해서_알린다() {
        let (m, _) = mock("* OK ready\r\ng1 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n");
        assert_eq!(
            fetch_attrs(m, "a", "b", "INBOX", &[1]).unwrap_err(),
            RawError::LoginRejected
        );
    }
}
