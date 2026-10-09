//! HTML 메일에서 미리보기·검색용 텍스트를 뽑는다. 네트워크와 무관한 순수 함수.
//!
//! 주석(Outlook 조건부 주석 포함)·`<style>`·`<script>`·`<head>`의 `<title>`은 내용째 버리고,
//! 블록 태그는 줄바꿈으로, 나머지 태그는 제거한다. 표시용이 아니므로 완벽한 HTML 파서는 아니다.

/// 내용까지 통째로 버리는 태그.
const DROP_CONTENT: [&str; 3] = ["style", "script", "title"];

/// 앞뒤로 줄바꿈을 넣는 태그.
const BLOCK_TAGS: [&str; 18] = [
    "p",
    "div",
    "br",
    "tr",
    "li",
    "ul",
    "ol",
    "table",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "hr",
    "section",
    "article",
];

/// 앞뒤로 빈 줄까지 넣는 태그.
const PARAGRAPH_TAGS: [&str; 8] = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"];

/// 끝에 줄바꿈이 `n`개가 되도록 채운다. 이미 있으면 더하지 않아 블록이 겹쳐도 빈 줄이 늘지 않는다.
fn ensure_break(out: &mut String, n: usize) {
    let trimmed = out.trim_end_matches(' ');
    let have = trimmed.len() - trimmed.trim_end_matches('\n').len();
    for _ in have..n {
        out.push('\n');
    }
}

/// 프리헤더 여백 채우기에 쓰이는, 화면에 보이지 않는 문자.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}' | '\u{00ad}' | '\u{034f}' | '\u{2060}'
    )
}

pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut rest = html;

    while let Some(lt) = rest.find('<') {
        push_text(&mut out, &rest[..lt]);
        rest = &rest[lt..];

        if let Some(after) = rest.strip_prefix("<!--") {
            // `<!--[if mso]> … <![endif]-->`도 주석 하나로 끝난다.
            rest = after.find("-->").map_or("", |i| &after[i + 3..]);
        } else if rest.starts_with("<!") || rest.starts_with("<?") {
            // doctype, `<![endif]>` 같은 선언
            rest = rest.find('>').map_or("", |i| &rest[i + 1..]);
        } else if rest[1..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '/')
        {
            let end = tag_end(rest);
            let tag = &rest[1..end.saturating_sub(1).max(1)];
            let (closing, name) = tag_name(tag);
            rest = &rest[end..];
            if !closing && DROP_CONTENT.contains(&name.as_str()) {
                rest = skip_until_close(rest, &name);
            } else if BLOCK_TAGS.contains(&name.as_str()) {
                let blank = PARAGRAPH_TAGS.contains(&name.as_str());
                ensure_break(&mut out, if blank { 2 } else { 1 });
            } else if closing && matches!(name.as_str(), "td" | "th") {
                out.push(' ');
            }
        } else {
            out.push('<');
            rest = &rest[1..];
        }
    }
    push_text(&mut out, rest);
    tidy(&out)
}

/// `<`로 시작하는 태그가 끝나는 위치(`>` 다음 바이트 인덱스). 따옴표 안의 `>`는 무시한다.
fn tag_end(s: &str) -> usize {
    let mut quote: Option<char> = None;
    for (i, c) in s.char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, '>') => return i + 1,
            _ => {}
        }
    }
    s.len()
}

fn tag_name(tag: &str) -> (bool, String) {
    let (closing, body) = match tag.strip_prefix('/') {
        Some(b) => (true, b),
        None => (false, tag),
    };
    let name = body
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    (closing, name)
}

/// `</name>` 뒤로 건너뛴다. 닫는 태그가 없으면 나머지를 모두 버린다.
fn skip_until_close<'a>(s: &'a str, name: &str) -> &'a str {
    let needle = format!("</{name}");
    let lower = s.to_ascii_lowercase();
    match lower.find(&needle) {
        Some(i) => &s[i + tag_end(&s[i..])..],
        None => "",
    }
}

fn push_text(out: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    out.push_str(&decode_entities(text));
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let decoded = rest
            .find(';')
            .filter(|&semi| semi <= 10)
            .and_then(|semi| entity(&rest[1..semi]).map(|c| (c, semi)));
        match decoded {
            Some((c, semi)) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" | "ensp" | "emsp" | "thinsp" => Some(' '),
        // 프리헤더 여백에 쓰이는 보이지 않는 문자는 tidy()가 걸러낸다.
        "zwnj" => Some('\u{200c}'),
        "zwj" => Some('\u{200d}'),
        "shy" => Some('\u{00ad}'),
        "hellip" => Some('…'),
        "middot" => Some('·'),
        "ndash" => Some('–'),
        "mdash" => Some('—'),
        "copy" => Some('©'),
        "lsquo" => Some('‘'),
        "rsquo" => Some('’'),
        "ldquo" => Some('“'),
        "rdquo" => Some('”'),
        _ => {
            let digits = name.strip_prefix('#')?;
            let code = match digits.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => digits.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

/// 공백을 줄이고, 빈 줄이 두 번 넘게 이어지지 않게 정리한다.
fn tidy(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in text.replace('\r', "").split('\n') {
        let cleaned = line
            .chars()
            .filter(|c| !is_invisible(*c))
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if cleaned.is_empty() && lines.last().is_none_or(|l| l.is_empty()) {
            continue;
        }
        lines.push(cleaned);
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 주석과_outlook_조건부_주석을_버린다() {
        let html = "<!--[if mso]><table><tr><td>MSO 전용</td></tr></table><![endif]-->\
                    <p>안녕하세요</p><!-- 메모 -->";
        assert_eq!(html_to_text(html), "안녕하세요");
    }

    #[test]
    fn 다운레벨_노출_조건부_주석_안의_본문은_남긴다() {
        let html = "<!--[if !mso]><!--><p>본문</p><!--<![endif]-->";
        assert_eq!(html_to_text(html), "본문");
    }

    #[test]
    fn 선언형_조건부_주석도_버린다() {
        let html = "<![if !mso]><p>본문</p><![endif]>";
        assert_eq!(html_to_text(html), "본문");
    }

    #[test]
    fn style_script_title은_내용째_버린다() {
        let html = "<html><head><title>제목</title><style>p { color: red }</style></head>\
                    <body><script>alert('x < y')</script><p>본문</p></body></html>";
        assert_eq!(html_to_text(html), "본문");
    }

    #[test]
    fn 대문자_태그와_닫는_태그_없는_style도_처리한다() {
        assert_eq!(html_to_text("<STYLE>a{}</STYLE>글"), "글");
        assert_eq!(html_to_text("글<style>a{}"), "글");
    }

    #[test]
    fn 블록_태그는_줄바꿈_셀은_공백으로_바꾼다() {
        let html = "<div>첫 줄</div><div>둘째 줄<br>셋째 줄</div><table><tr><td>A</td><td>B</td></tr></table>";
        assert_eq!(html_to_text(html), "첫 줄\n둘째 줄\n셋째 줄\nA B");
    }

    #[test]
    fn 엔티티를_풀고_속성_안의_꺾쇠는_무시한다() {
        let html = "<a title=\"a>b\" href='x'>5 &lt; 6 &amp;&nbsp;&#54620;&#xAE00; &unknown; &</a>";
        assert_eq!(html_to_text(html), "5 < 6 & 한글 &unknown; &");
    }

    #[test]
    fn 보이지_않는_여백_문자와_연속_빈_줄을_정리한다() {
        let html = "<div>\u{200c}\u{200b} \u{034f}</div><p>가</p><p></p><p></p><p>나</p>";
        assert_eq!(html_to_text(html), "가\n\n나");
    }

    #[test]
    fn 깨진_html도_패닉하지_않는다() {
        for html in [
            "<",
            "<p",
            "<!--",
            "<!-- x",
            "a < b",
            "<style",
            "&#99999999;",
            "",
        ] {
            let _ = html_to_text(html);
        }
        assert_eq!(html_to_text("a < b"), "a < b");
    }
}
