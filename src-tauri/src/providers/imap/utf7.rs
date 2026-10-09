//! IMAP 폴더명의 modified UTF-7(RFC 3501 §5.1.3) 디코딩.
//! `&`로 시작해 `-`로 끝나는 구간이 UTF-16BE를 base64(`,`가 `/`)로 인코딩한 것이다.

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

fn sextet(c: u8) -> Option<u32> {
    BASE64.iter().position(|&b| b == c).map(|p| p as u32)
}

/// 잘못된 구간은 건드리지 않고 원문 그대로 둔다. 폴더명을 못 읽어서 목록이 깨지면 안 된다.
pub fn decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            let next = input[i..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&input[i..i + next]);
            i += next;
            continue;
        }
        let Some(end) = bytes[i + 1..].iter().position(|&b| b == b'-') else {
            out.push_str(&input[i..]);
            break;
        };
        let encoded = &bytes[i + 1..i + 1 + end];
        if encoded.is_empty() {
            out.push('&'); // "&-"는 '&' 자체
        } else if let Some(text) = decode_run(encoded) {
            out.push_str(&text);
        } else {
            out.push_str(&input[i..i + end + 2]);
        }
        i += end + 2;
    }
    out
}

fn decode_run(encoded: &[u8]) -> Option<String> {
    let mut units = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &c in encoded {
        acc = (acc << 6) | sextet(c)?;
        bits += 6;
        if bits >= 16 {
            bits -= 16;
            units.push((acc >> bits) as u16);
            acc &= (1 << bits) - 1;
        }
    }
    String::from_utf16(&units).ok()
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn ascii는_그대로() {
        assert_eq!(decode("INBOX"), "INBOX");
        assert_eq!(decode("Sent Messages"), "Sent Messages");
    }

    #[test]
    fn 네이버_한글_폴더() {
        assert_eq!(decode("&vPSwuLpUx3w-"), "보낸메일");
        assert_eq!(decode("&1zTJwNG1-"), "휴지통");
        assert_eq!(decode("&x4TC3Lz0rQA-"), "임시보관");
    }

    #[test]
    fn 하위_폴더와_섞인_이름() {
        assert_eq!(decode("&vPSwuLpUx3w-/2024"), "보낸메일/2024");
        assert_eq!(decode("Work &1ozArA-"), "Work 회사");
    }

    #[test]
    fn 앰퍼샌드_이스케이프() {
        assert_eq!(decode("A&-B"), "A&B");
    }

    #[test]
    fn 깨진_입력은_원문_유지() {
        assert_eq!(decode("&!!!-"), "&!!!-");
        assert_eq!(decode("abc&xyz"), "abc&xyz");
    }
}
