//! Windows 토스트 알림(버튼·클릭). `tauri-plugin-notification`은 데스크톱에서 버튼·클릭 이벤트를 지원하지 않아
//! WinRT `ToastNotification`을 직접 쓴다. 활성화 이벤트는 토스트 객체에 붙여 앱이 떠 있는 동안 받는다(트레이 상주).
//! 토스트 XML·활성화 인자 규칙은 `notify.rs`에 있고(테스트 대상), 여기는 OS 호출과 동작 연결만 한다.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::notify::{self, Toast, ToastAction};
use crate::store::Store;
use crate::sync::actions;
use crate::sync::manager::SyncManager;

/// 토스트를 눌렀을 때 화면에 알리는 내용
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OpenMail {
    mail_id: String,
    account_id: String,
    folder_id: String,
}

/// 토스트를 띄운다. 실패하면 호출한 쪽이 플러그인 알림으로 되돌아간다.
pub fn show(app: &AppHandle, toast: &Toast) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::show(app, toast)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, toast);
        Err("이 플랫폼은 토스트를 지원하지 않아요.".into())
    }
}

/// 토스트 활성화 인자(클릭·버튼)를 처리한다. 검증에 실패하거나 메일이 없으면 아무것도 하지 않는다.
pub fn handle_activation(app: &AppHandle, args: &str) {
    let Some((action, mail_id)) = notify::parse_args(args) else {
        return;
    };
    let Some(store) = app.try_state::<Store>() else {
        return;
    };
    let Ok(Some(mail)) = store.mail_ref(&mail_id) else {
        return;
    };
    match action {
        ToastAction::Open => {
            crate::tray::show_main(app);
            let _ = app.emit(
                "open-mail",
                OpenMail {
                    mail_id,
                    account_id: mail.account_id,
                    folder_id: mail.folder_id,
                },
            );
        }
        ToastAction::MarkRead => {
            if actions::set_read(&store, &mail_id, true).is_ok() {
                if let Some(manager) = app.try_state::<SyncManager>() {
                    manager.kick(app, &mail.account_id);
                }
                crate::tray::refresh(app);
            }
        }
        ToastAction::Archive => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let (Some(store), Some(manager)) =
                    (app.try_state::<Store>(), app.try_state::<SyncManager>())
                else {
                    return;
                };
                let provider = manager.provider(&mail.account_id);
                if actions::archive_mail(&store, provider.as_deref(), &mail_id)
                    .await
                    .is_ok()
                {
                    manager.kick(&app, &mail.account_id);
                    crate::tray::refresh(&app);
                }
            });
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::{Mutex, Once};

    use tauri::AppHandle;
    use windows::core::{Interface, HSTRING, PCWSTR};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    use windows::UI::Notifications::{
        ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
    };

    use crate::notify::{toast_xml, Toast};

    static REGISTER: Once = Once::new();
    /// 활성화 콜백을 받으려면 토스트 객체가 살아 있어야 해서 최근 것을 들고 있는다.
    static LIVE: Mutex<Vec<ToastNotification>> = Mutex::new(Vec::new());
    const KEEP: usize = 30;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 앱 식별자(AUMID)를 프로세스에 지정하고, 알림 센터에 보일 이름을 레지스트리에 등록한다.
    /// 설치본(NSIS)과 개발 모드 모두 같은 방식이라 바로가기 없이도 토스트가 뜬다.
    fn register_app(aumid: &str) {
        REGISTER.call_once(|| {
            let id = HSTRING::from(aumid);
            // SAFETY: 유효한 널 종료 문자열을 넘긴다.
            let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(&id) };
            let key_path = wide(&format!("Software\\Classes\\AppUserModelId\\{aumid}"));
            let mut key = HKEY::default();
            // SAFETY: 모든 포인터는 이 함수의 지역 버퍼를 가리키고 호출 동안 유효하다.
            unsafe {
                let status = RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(key_path.as_ptr()),
                    None,
                    PCWSTR::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_WRITE,
                    None,
                    &mut key,
                    None,
                );
                if status.is_ok() {
                    let name = wide("DisplayName");
                    let value = wide("MyMail");
                    let bytes =
                        std::slice::from_raw_parts(value.as_ptr().cast::<u8>(), value.len() * 2);
                    let _ = RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(bytes));
                    let _ = RegCloseKey(key);
                }
            }
        });
    }

    pub fn show(app: &AppHandle, toast: &Toast) -> Result<(), String> {
        let aumid = app.config().identifier.clone();
        register_app(&aumid);
        build_and_show(app, &aumid, toast).map_err(|e| e.to_string())
    }

    fn build_and_show(app: &AppHandle, aumid: &str, toast: &Toast) -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(toast_xml(toast)))?;
        let notification = ToastNotification::CreateToastNotification(&doc)?;
        let handle = app.clone();
        notification.Activated(&TypedEventHandler::new(
            move |_sender: windows::core::Ref<'_, ToastNotification>,
                  args: windows::core::Ref<'_, windows::core::IInspectable>| {
                if let Some(event) = args.as_ref() {
                    if let Ok(event) = event.cast::<ToastActivatedEventArgs>() {
                        if let Ok(arguments) = event.Arguments() {
                            super::handle_activation(&handle, &arguments.to_string());
                        }
                    }
                }
                Ok(())
            },
        ))?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid))?;
        notifier.Show(&notification)?;
        if let Ok(mut live) = LIVE.lock() {
            live.push(notification);
            if live.len() > KEEP {
                live.remove(0);
            }
        }
        Ok(())
    }
}
