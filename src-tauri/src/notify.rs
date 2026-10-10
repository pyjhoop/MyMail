//! 새 메일 Windows 알림. 동기화가 새로 받은 안 읽은 메일을 계정별 설정(켜기/끄기·대상·소리)에 맞춰 알린다.
//! 알림 일시 중지는 모든 계정보다 우선한다.

use chrono::{Duration, Local, TimeZone};
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

pub fn show(app: &AppHandle, account_name: &str, settings: &NotifySettings, mails: &[NewMail]) {
    for (title, body) in messages(account_name, mails) {
        let builder = app.notification().builder().title(title).body(body);
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
