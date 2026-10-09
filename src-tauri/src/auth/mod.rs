//! 앱 비밀번호 저장소. Windows 자격 증명 관리자(keyring)에만 저장하고, 로그·DB·파일에는 남기지 않는다.

const SERVICE: &str = "MyMail";

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("자격 증명 저장소 오류: {0}")]
    Keyring(String),
}

impl From<keyring::Error> for AuthError {
    fn from(e: keyring::Error) -> Self {
        Self::Keyring(e.to_string())
    }
}

/// 계정 id별 비밀번호를 보관한다. 테스트에서는 메모리 구현으로 바꿔 끼운다.
pub trait CredentialStore: Send + Sync {
    fn save(&self, account_id: &str, password: &str) -> Result<(), AuthError>;
    #[allow(dead_code)] // M5 동기화가 저장된 비밀번호를 읽을 때 사용
    fn load(&self, account_id: &str) -> Result<Option<String>, AuthError>;
    fn delete(&self, account_id: &str) -> Result<(), AuthError>;
}

pub struct KeyringStore;

impl KeyringStore {
    fn entry(account_id: &str) -> Result<keyring::Entry, AuthError> {
        Ok(keyring::Entry::new(SERVICE, account_id)?)
    }
}

impl CredentialStore for KeyringStore {
    fn save(&self, account_id: &str, password: &str) -> Result<(), AuthError> {
        Ok(Self::entry(account_id)?.set_password(password)?)
    }

    fn load(&self, account_id: &str) -> Result<Option<String>, AuthError> {
        match Self::entry(account_id)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn delete(&self, account_id: &str) -> Result<(), AuthError> {
        match Self::entry(account_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
pub mod memory {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::{AuthError, CredentialStore};

    #[derive(Default)]
    pub struct MemoryStore(Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryStore {
        fn save(&self, account_id: &str, password: &str) -> Result<(), AuthError> {
            self.0
                .lock()
                .map_err(|_| AuthError::Keyring("잠금 오류".into()))?
                .insert(account_id.into(), password.into());
            Ok(())
        }

        fn load(&self, account_id: &str) -> Result<Option<String>, AuthError> {
            Ok(self
                .0
                .lock()
                .map_err(|_| AuthError::Keyring("잠금 오류".into()))?
                .get(account_id)
                .cloned())
        }

        fn delete(&self, account_id: &str) -> Result<(), AuthError> {
            self.0
                .lock()
                .map_err(|_| AuthError::Keyring("잠금 오류".into()))?
                .remove(account_id);
            Ok(())
        }
    }
}
