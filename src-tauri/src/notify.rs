//! 새 메일 Windows 알림. 동기화가 새로 받은 안 읽은 받은편지함 메일을 알린다.

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::store::NewMail;

/// 한꺼번에 알림 여러 개를 띄우지 않고 이 수를 넘으면 한 통으로 묶는다.
const MAX_SEPARATE: usize = 3;

/// 알림 (제목, 본문) 목록. 많이 쌓이면 개수만 알린다.
pub fn messages(account_name: &str, mails: &[NewMail]) -> Vec<(String, String)> {
    if mails.len() > MAX_SEPARATE {
        return vec![(
            account_name.to_string(),
            format!("새 메일 {}통이 도착했어요", mails.len()),
        )];
    }
    mails
        .iter()
        .map(|m| {
            let subject = if m.subject.trim().is_empty() {
                "(제목 없음)"
            } else {
                m.subject.as_str()
            };
            (m.sender.clone(), subject.to_string())
        })
        .collect()
}

pub fn show(app: &AppHandle, account_name: &str, mails: &[NewMail]) {
    for (title, body) in messages(account_name, mails) {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(sender: &str, subject: &str) -> NewMail {
        NewMail {
            sender: sender.into(),
            subject: subject.into(),
        }
    }

    #[test]
    fn 적은_수는_보낸사람과_제목으로_따로_알린다() {
        let out = messages("개인 Gmail", &[mail("김철수", "회의"), mail("이영희", "")]);
        assert_eq!(out[0], ("김철수".into(), "회의".into()));
        assert_eq!(out[1], ("이영희".into(), "(제목 없음)".into()));
    }

    #[test]
    fn 많이_쌓이면_한_통으로_묶는다() {
        let many: Vec<_> = (0..5).map(|i| mail("a", &i.to_string())).collect();
        let out = messages("개인 Gmail", &many);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, "새 메일 5통이 도착했어요");
    }
}
