//! 새 메일 Windows 알림. 동기화가 새로 받은 안 읽은 메일을 계정별 설정(켜기/끄기·대상·소리)에 맞춰 알린다.
//! 알림 일시 중지는 모든 계정보다 우선한다.

use chrono::{Duration, Local, TimeZone};
use std::sync::RwLock;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::store::{NewMail, NotifySettings};

/// Windows 알림음("Mail"은 기본 메일 알림음)
const NOTIFICATION_SOUND: &str = "Mail";

/// 한꺼번에 알림 여러 개를 띄우지 않고 이 수를 넘으면 한 통으로 묶는다.
const MAX_SEPARATE: usize = 3;

/// "다시 켤 때까지" 중지: 만료 시각이 없는 것과 같다.
pub const PAUSE_FOREVER: i64 = i64::MAX;

/// 알림 일시 중지 기간
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseSpan {
    OneHour,
    UntilTomorrow8am,
    UntilResumed,
}

/// 중지가 풀리는 시각(유닉스 초). `now`는 현재 시각(유닉스 초).
pub fn pause_until(span: PauseSpan, now: i64) -> i64 {
    match span {
        PauseSpan::OneHour => now + 3600,
        PauseSpan::UntilResumed => PAUSE_FOREVER,
        PauseSpan::UntilTomorrow8am => {
            let local = Local
                .timestamp_opt(now, 0)
                .single()
                .unwrap_or_else(Local::now);
            let tomorrow = local.date_naive() + Duration::days(1);
            tomorrow
                .and_hms_opt(8, 0, 0)
                .and_then(|t| Local.from_local_datetime(&t).earliest())
                .map_or(now + 12 * 3600, |t| t.timestamp())
        }
    }
}

/// 중지 중인가. 만료 시각이 지났으면 아니다.
pub fn is_paused(until: Option<i64>, now: i64) -> bool {
    until.is_some_and(|t| t > now)
}

pub fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// 알림 (제목, 본문) 목록. 제목은 "MyMail · 계정 이름", 본문은 보낸사람·제목·미리보기 줄. 많이 쌓이면 개수만 알린다.
pub fn messages(account_name: &str, mails: &[NewMail]) -> Vec<(String, String)> {
    let title = if account_name.is_empty() {
        "MyMail".to_string()
    } else {
        format!("MyMail · {account_name}")
    };
    if mails.len() > MAX_SEPARATE {
        return vec![(title, format!("새 메일 {}통이 도착했어요", mails.len()))];
    }
    mails
        .iter()
        .map(|m| {
            let subject = if m.subject.trim().is_empty() {
                "(제목 없음)"
            } else {
                m.subject.trim()
            };
            let mut body = format!("{}\n{subject}", m.sender);
            let preview = m.preview.trim();
            if !preview.is_empty() {
                body.push('\n');
                body.push_str(preview);
            }
            (title.clone(), body)
        })
        .collect()
}

/// 이 계정의 새 메일을 알려도 되는가(계정 설정과 일시 중지)
pub fn should_notify(settings: &NotifySettings, paused_until: Option<i64>, now: i64) -> bool {
    settings.enabled && !is_paused(paused_until, now)
}

/// 계정 색 번호(1..=8)별 색. 화면의 `--account-N` 토큰 값을 UI가 `set_account_palette`로 넘겨 준다(색 하드코딩 방지).
static PALETTE: RwLock<Vec<String>> = RwLock::new(Vec::new());

/// 토스트 색 링에 쓸 계정 색을 받는다. 형식(`#rrggbb`)이 틀린 항목은 쓸 때 건너뛴다.
pub fn set_palette(colors: Vec<String>) {
    if let Ok(mut p) = PALETTE.write() {
        *p = colors.into_iter().map(|c| c.trim().to_string()).collect();
    }
}

/// 계정 색 번호의 `[r, g, b]`. 아직 팔레트를 못 받았거나 형식이 틀리면 중립 회색.
pub fn account_rgb(color_index: u8) -> [u8; 3] {
    const NEUTRAL: [u8; 3] = [0x71, 0x71, 0x7a];
    let Ok(palette) = PALETTE.read() else {
        return NEUTRAL;
    };
    palette
        .get(usize::from(color_index).saturating_sub(1))
        .and_then(|c| parse_hex_color(c))
        .unwrap_or(NEUTRAL)
}

pub fn parse_hex_color(text: &str) -> Option<[u8; 3]> {
    let hex = text.strip_prefix('#')?;
    if hex.len() != 6 || !hex.is_ascii() {
        return None;
    }
    let v = u32::from_str_radix(hex, 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

// ---------- 토스트 내용 ----------

/// 활성화(클릭·버튼) 인자에 담는 동작
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastAction {
    Open,
    Archive,
    MarkRead,
}

impl ToastAction {
    fn key(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Archive => "archive",
            Self::MarkRead => "read",
        }
    }
}

/// 메일 ID 최대 길이(활성화 인자 검증용)
const MAX_ID_LEN: usize = 512;

fn is_plain(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')
}

/// 활성화 인자: `a=<동작>&id=<퍼센트 인코딩한 메일 ID>`. 메일 ID만 담는다.
pub fn encode_args(action: ToastAction, mail_id: &str) -> String {
    let mut out = format!("a={}&id=", action.key());
    for b in mail_id.bytes() {
        if is_plain(b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 활성화 인자를 풀어 (동작, 메일 ID)로 돌려준다. 형식이 틀리거나 ID가 비정상이면 `None`.
/// 존재하는 메일인지는 호출한 쪽이 DB로 다시 확인한다.
pub fn parse_args(args: &str) -> Option<(ToastAction, String)> {
    let (head, id_part) = args.split_once('&')?;
    let action = match head.strip_prefix("a=")? {
        "open" => ToastAction::Open,
        "archive" => ToastAction::Archive,
        "read" => ToastAction::MarkRead,
        _ => return None,
    };
    let raw = id_part.strip_prefix("id=")?;
    if raw.is_empty() || raw.len() > MAX_ID_LEN * 3 {
        return None;
    }
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = raw.get(i + 1..i + 3)?;
                decoded.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b if is_plain(b) => {
                decoded.push(b);
                i += 1;
            }
            _ => return None,
        }
    }
    let id = String::from_utf8(decoded).ok()?;
    if id.is_empty() || id.len() > MAX_ID_LEN || id.chars().any(char::is_control) {
        return None;
    }
    Some((action, id))
}

pub fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() && c != '\n' => {}
            c => out.push(c),
        }
    }
    out
}

/// 토스트 한 개의 내용
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toast {
    pub title: String,
    /// 본문 줄들(보낸사람, 제목, 미리보기)
    pub lines: Vec<String>,
    /// 메일 한 통짜리 토스트면 그 ID. 있으면 클릭·버튼이 붙는다.
    pub mail_id: Option<String>,
    /// 보낸사람 이미지(색 링)의 `file:///` URI
    pub ring_image: Option<String>,
    pub silent: bool,
}

/// Windows 토스트 XML. 모든 문자열은 이스케이프한다.
pub fn toast_xml(t: &Toast) -> String {
    let launch = t.mail_id.as_deref().map_or_else(String::new, |id| {
        format!(
            " launch=\"{}\" activationType=\"foreground\"",
            xml_escape(&encode_args(ToastAction::Open, id))
        )
    });
    let mut xml = format!("<toast{launch}><visual><binding template=\"ToastGeneric\">");
    if let Some(img) = &t.ring_image {
        xml.push_str(&format!(
            "<image placement=\"appLogoOverride\" src=\"{}\"/>",
            xml_escape(img)
        ));
    }
    xml.push_str(&format!("<text>{}</text>", xml_escape(&t.title)));
    for line in &t.lines {
        xml.push_str(&format!("<text>{}</text>", xml_escape(line)));
    }
    xml.push_str("</binding></visual>");
    if let Some(id) = &t.mail_id {
        xml.push_str("<actions>");
        for (label, action) in [
            ("보관", ToastAction::Archive),
            ("읽음으로 표시", ToastAction::MarkRead),
        ] {
            xml.push_str(&format!(
                "<action content=\"{}\" arguments=\"{}\" activationType=\"background\"/>",
                xml_escape(label),
                xml_escape(&encode_args(action, id))
            ));
        }
        xml.push_str("</actions>");
    }
    if t.silent {
        xml.push_str("<audio silent=\"true\"/>");
    } else {
        xml.push_str("<audio src=\"ms-winsoundevent:Notification.Mail\"/>");
    }
    xml.push_str("</toast>");
    xml
}

/// 한 통짜리 알림은 메일 ID와 색 링을 담는다. 묶음 알림은 ID 없이 앱만 연다.
fn toasts(
    account_name: &str,
    color_index: u8,
    settings: &NotifySettings,
    mails: &[NewMail],
) -> Vec<Toast> {
    let ring = ring_image_path(color_index);
    let grouped = mails.len() > MAX_SEPARATE;
    messages(account_name, mails)
        .into_iter()
        .enumerate()
        .map(|(i, (title, body))| Toast {
            title,
            lines: body.split('\n').map(str::to_string).collect(),
            mail_id: if grouped {
                None
            } else {
                mails.get(i).map(|m| m.id.clone())
            },
            ring_image: ring.clone(),
            silent: !settings.sound,
        })
        .collect()
}

// ---------- 색 링 이미지 ----------

/// 96x96 색 링 PNG(가운데는 같은 색의 옅은 채움). 가장자리는 부드럽게 처리한다.
pub fn ring_png(rgb: [u8; 3]) -> Vec<u8> {
    const SIZE: u32 = 96;
    let c = (SIZE as f32 - 1.0) / 2.0;
    let (outer, inner) = (46.0_f32, 38.0_f32);
    let mut px = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let edge = (outer + 0.5 - d).clamp(0.0, 1.0);
            let alpha = if d >= inner { edge } else { 0.22 };
            px.extend_from_slice(&[rgb[0], rgb[1], rgb[2], (alpha * 255.0) as u8]);
        }
    }
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, SIZE, SIZE);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    if let Ok(mut w) = enc.write_header() {
        let _ = w.write_image_data(&px);
    }
    out
}

/// 색 링 PNG를 임시 폴더에 만들고(이미 있으면 재사용) `file:///` URI를 돌려준다.
fn ring_image_path(color_index: u8) -> Option<String> {
    let rgb = account_rgb(color_index);
    let dir = std::env::temp_dir().join("mymail-toast");
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!(
        "ring-{:02x}{:02x}{:02x}.png",
        rgb[0], rgb[1], rgb[2]
    ));
    if !file.exists() {
        std::fs::write(&file, ring_png(rgb)).ok()?;
    }
    Some(format!(
        "file:///{}",
        file.to_string_lossy().replace('\\', "/")
    ))
}

// ---------- 배지 숫자 ----------

/// 작업 표시줄 배지 글자. 0이면 배지 없음, 99를 넘으면 "99+".
pub fn badge_text(unread: u32) -> Option<String> {
    match unread {
        0 => None,
        1..=99 => Some(unread.to_string()),
        _ => Some("99+".into()),
    }
}

/// 3x5 숫자 글꼴(행마다 3비트)
fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0; 5],
    }
}

pub const BADGE_SIZE: u32 = 32;

/// 빨간 원 위에 흰 숫자를 그린 오버레이 아이콘(32x32 RGBA)
pub fn badge_rgba(text: &str) -> Vec<u8> {
    let size = BADGE_SIZE as usize;
    let mut buf = vec![0u8; size * size * 4];
    let mut put = |x: usize, y: usize, rgba: [u8; 4]| {
        let i = (y * size + x) * 4;
        buf[i..i + 4].copy_from_slice(&rgba);
    };
    let c = (size as f32 - 1.0) / 2.0;
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let a = (c + 0.5 - d).clamp(0.0, 1.0);
            if a > 0.0 {
                put(x, y, [0xE5, 0x39, 0x35, (a * 255.0) as u8]);
            }
        }
    }
    let chars: Vec<char> = text.chars().collect();
    let scale = if chars.len() >= 3 { 2 } else { 3 };
    let gap = scale;
    let width = (chars.len() * 3 * scale + chars.len().saturating_sub(1) * gap).min(size);
    let height = 5 * scale;
    let (x0, y0) = ((size - width) / 2, (size - height) / 2);
    for (n, ch) in chars.iter().enumerate() {
        let gx = x0 + n * (3 * scale + gap);
        for (row, bits) in glyph(*ch).iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) != 0 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            put(gx + col * scale + dx, y0 + row * scale + dy, [255; 4]);
                        }
                    }
                }
            }
        }
    }
    buf
}

/// 새 메일 알림. Windows 토스트(버튼·클릭·색 링)를 먼저 시도하고, 실패하면 플러그인 알림(버튼 없음)으로 되돌아간다.
pub fn show(
    app: &AppHandle,
    account_name: &str,
    color_index: u8,
    settings: &NotifySettings,
    mails: &[NewMail],
) {
    for toast in toasts(account_name, color_index, settings, mails) {
        if crate::toast::show(app, &toast).is_ok() {
            continue;
        }
        let builder = app
            .notification()
            .builder()
            .title(&toast.title)
            .body(toast.lines.join("\n"));
        let _ = if settings.sound {
            builder.sound(NOTIFICATION_SOUND).show()
        } else {
            builder.show()
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(sender: &str, subject: &str, preview: &str) -> NewMail {
        NewMail {
            id: "acc1:inbox:42".into(),
            sender: sender.into(),
            subject: subject.into(),
            preview: preview.into(),
        }
    }

    #[test]
    fn 적은_수는_보낸사람_제목_미리보기로_따로_알린다() {
        let out = messages(
            "개인 Gmail",
            &[
                mail("김철수", "회의", "내일 3시에 봐요"),
                mail("이영희", "", ""),
            ],
        );
        assert_eq!(out[0].0, "MyMail · 개인 Gmail");
        assert_eq!(out[0].1, "김철수\n회의\n내일 3시에 봐요");
        assert_eq!(out[1].1, "이영희\n(제목 없음)");
    }

    fn sample_toast(mail_id: Option<&str>) -> Toast {
        Toast {
            title: "MyMail · 네이버".into(),
            lines: vec!["A <b> & \"C\"".into(), "제목".into()],
            mail_id: mail_id.map(str::to_string),
            ring_image: Some("file:///C:/t/ring.png".into()),
            silent: false,
        }
    }

    #[test]
    fn 토스트_xml에_제목_본문_버튼_인자가_들어간다() {
        let xml = toast_xml(&sample_toast(Some("acc1:inbox:42")));
        assert!(xml.contains("<text>MyMail · 네이버</text>"));
        assert!(xml.contains("<text>제목</text>"));
        assert!(xml.contains("content=\"보관\" arguments=\"a=archive&amp;id=acc1%3Ainbox%3A42\""));
        assert!(
            xml.contains("content=\"읽음으로 표시\" arguments=\"a=read&amp;id=acc1%3Ainbox%3A42\"")
        );
        assert!(xml.contains("launch=\"a=open&amp;id=acc1%3Ainbox%3A42\""));
        assert!(xml.contains("appLogoOverride"));
        assert!(xml.contains("ms-winsoundevent:Notification.Mail"));
    }

    #[test]
    fn 토스트_xml은_특수문자를_이스케이프한다() {
        let xml = toast_xml(&sample_toast(None));
        assert!(xml.contains("<text>A &lt;b&gt; &amp; &quot;C&quot;</text>"));
        assert!(!xml.contains("<b>"));
    }

    #[test]
    fn 묶음_알림과_소리_끔은_버튼_없이_무음이다() {
        let mut t = sample_toast(None);
        t.silent = true;
        let xml = toast_xml(&t);
        assert!(!xml.contains("<actions>"));
        assert!(!xml.contains("launch="));
        assert!(xml.contains("silent=\"true\""));
    }

    #[test]
    fn 활성화_인자는_왕복하고_잘못된_것은_거절한다() {
        for id in ["acc1:inbox:42", "a/b c&d=e%f", "한글:1"] {
            for action in [
                ToastAction::Open,
                ToastAction::Archive,
                ToastAction::MarkRead,
            ] {
                let args = encode_args(action, id);
                assert_eq!(parse_args(&args), Some((action, id.to_string())));
            }
        }
        for bad in [
            "",
            "a=open",
            "a=open&id=",
            "a=delete&id=1",
            "id=1&a=open",
            "a=open&id=a:b",
            "a=open&id=%zz",
            "a=open&id=%",
            "a=open&id=%00",
            "a=open&id=%FF",
            "a=open&id=1&x=2",
        ] {
            assert_eq!(parse_args(bad), None, "{bad}");
        }
        let long = format!("a=open&id={}", "a".repeat(MAX_ID_LEN + 1));
        assert_eq!(parse_args(&long), None);
    }

    #[test]
    fn 배지_숫자_글자_규칙() {
        assert_eq!(badge_text(0), None);
        assert_eq!(badge_text(7).as_deref(), Some("7"));
        assert_eq!(badge_text(99).as_deref(), Some("99"));
        assert_eq!(badge_text(100).as_deref(), Some("99+"));
        assert_eq!(badge_text(5000).as_deref(), Some("99+"));
    }

    #[test]
    fn 배지_아이콘은_원_위에_흰_글자를_그린다() {
        let size = BADGE_SIZE as usize;
        for text in ["7", "42", "99+"] {
            let px = badge_rgba(text);
            assert_eq!(px.len(), size * size * 4);
            assert_eq!(px[3], 0, "모서리는 투명");
            let white = px.chunks(4).filter(|p| p == &[255, 255, 255, 255]).count();
            assert!(white > 10, "{text}");
        }
    }

    #[test]
    fn 색_링은_png이고_색_형식을_검사한다() {
        let png = ring_png([0x25, 0x63, 0xeb]);
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(parse_hex_color("#2563eb"), Some([0x25, 0x63, 0xeb]));
        assert_eq!(parse_hex_color("2563eb"), None);
        assert_eq!(parse_hex_color("#25"), None);
        assert_eq!(parse_hex_color("#zzzzzz"), None);
    }

    #[test]
    fn 많이_쌓이면_한_통으로_묶는다() {
        let many: Vec<_> = (0..5).map(|i| mail("a", &i.to_string(), "")).collect();
        let out = messages("개인 Gmail", &many);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, "새 메일 5통이 도착했어요");
    }

    #[test]
    fn 계정_알림을_끄면_알리지_않는다() {
        let on = NotifySettings::default();
        let off = NotifySettings {
            enabled: false,
            ..NotifySettings::default()
        };
        assert!(should_notify(&on, None, 1000));
        assert!(!should_notify(&off, None, 1000));
    }

    #[test]
    fn 일시_중지_중에는_알리지_않고_만료되면_다시_알린다() {
        let on = NotifySettings::default();
        assert!(!should_notify(&on, Some(2000), 1000));
        assert!(should_notify(&on, Some(2000), 2000));
        assert!(should_notify(&on, Some(2000), 3000));
        assert!(!should_notify(&on, Some(PAUSE_FOREVER), 3000));
    }

    #[test]
    fn 중지_기간별_만료_시각() {
        let now = 1_760_000_000;
        assert_eq!(pause_until(PauseSpan::OneHour, now), now + 3600);
        assert_eq!(pause_until(PauseSpan::UntilResumed, now), PAUSE_FOREVER);
        let tomorrow = pause_until(PauseSpan::UntilTomorrow8am, now);
        assert!(tomorrow > now && tomorrow <= now + 32 * 3600);
        let local = Local.timestamp_opt(tomorrow, 0).single().unwrap();
        assert_eq!(local.format("%H:%M").to_string(), "08:00");
    }
}
