//! IMAP 공통 구현. 서비스별 차이는 `ImapConfig` 값으로만 주입한다.

mod gmail_ext;
mod html_text;
mod parse;
pub mod utf7;

use std::collections::{HashMap, HashSet};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use async_trait::async_trait;
use native_tls::{TlsConnector, TlsStream};

use super::{FolderKind, MailProvider, ProviderError, RemoteFolder, RemoteMessage};
use gmail_ext::GmailAttrs;
use parse::{parse_message, FetchedMessage};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(60);
/// 한 번의 FETCH로 받는 메일 수. 본문 전체를 받으므로 작게 유지한다.
const FETCH_CHUNK: usize = 50;

/// 서비스마다 다른 값. 새 서비스는 이 구조체만 채우면 된다.
#[derive(Debug, Clone)]
pub struct ImapConfig {
    pub host: &'static str,
    pub port: u16,
    /// 로그인이 거부됐을 때 사용자에게 보여줄 안내
    pub auth_hint: &'static str,
    /// SPECIAL-USE 속성이 없는 서버를 위한 폴더 이름(소문자) → 종류
    pub name_kinds: &'static [(&'static str, FolderKind)],
    /// 목록에서 뺄 SPECIAL-USE 속성(소문자). 다른 폴더의 사본을 보여 주는 가상 폴더용
    pub hidden_special_use: &'static [&'static str],
    /// Gmail 확장(X-GM-MSGID·THRID·LABELS)을 쓸지
    pub gmail_extensions: bool,
}

#[derive(Clone)]
pub struct ImapProvider {
    config: ImapConfig,
    email: String,
    password: String,
}

type Session = imap::Session<TlsStream<TcpStream>>;

/// (서버 원본 이름, 디코딩한 이름, 구분자, 종류)
type RawFolder = (String, String, Option<String>, FolderKind);

impl ImapProvider {
    pub fn new(config: ImapConfig, email: String, password: String) -> Self {
        Self {
            config,
            email,
            password,
        }
    }

    async fn blocking<T, F>(&self, work: F) -> Result<T, ProviderError>
    where
        T: Send + 'static,
        F: FnOnce(&Self) -> Result<T, ProviderError> + Send + 'static,
    {
        let this = self.clone();
        tokio::task::spawn_blocking(move || work(&this))
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?
    }

    fn open_tls(&self) -> Result<TlsStream<TcpStream>, ProviderError> {
        let addr = (self.config.host, self.config.port)
            .to_socket_addrs()
            .map_err(network)?
            .next()
            .ok_or_else(|| ProviderError::Network("서버 주소를 찾을 수 없어요".into()))?;
        let tcp = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(network)?;
        tcp.set_read_timeout(Some(IO_TIMEOUT)).map_err(network)?;
        tcp.set_write_timeout(Some(IO_TIMEOUT)).map_err(network)?;
        TlsConnector::new()
            .map_err(|e| ProviderError::Network(e.to_string()))?
            .connect(self.config.host, tcp)
            .map_err(|e| ProviderError::Network(e.to_string()))
    }

    fn connect(&self) -> Result<Session, ProviderError> {
        let tls = self.open_tls()?;
        let mut client = imap::Client::new(tls);
        client.read_greeting().map_err(map_imap_error)?;
        client
            .login(&self.email, &self.password)
            .map_err(|(e, _)| match e {
                imap::Error::No(_) | imap::Error::Bad(_) => {
                    ProviderError::Auth(self.config.auth_hint.into())
                }
                other => map_imap_error(other),
            })
    }

    fn classify(&self, attrs: &[imap::types::NameAttribute], decoded: &str) -> FolderKind {
        if decoded.eq_ignore_ascii_case("INBOX") {
            return FolderKind::Inbox;
        }
        let special = attrs.iter().find_map(|a| match a {
            imap::types::NameAttribute::Custom(s) => match s.to_ascii_lowercase().as_str() {
                "\\sent" => Some(FolderKind::Sent),
                "\\drafts" => Some(FolderKind::Drafts),
                "\\junk" => Some(FolderKind::Spam),
                "\\trash" => Some(FolderKind::Trash),
                "\\all" => Some(FolderKind::All),
                _ => None,
            },
            _ => None,
        });
        special
            .or_else(|| {
                let lower = decoded.to_lowercase();
                self.config
                    .name_kinds
                    .iter()
                    .find(|(name, _)| *name == lower)
                    .map(|(_, kind)| *kind)
            })
            .unwrap_or(FolderKind::Folder)
    }

    fn is_hidden(&self, attrs: &[imap::types::NameAttribute]) -> bool {
        attrs.iter().any(|a| match a {
            imap::types::NameAttribute::Custom(s) => self
                .config
                .hidden_special_use
                .iter()
                .any(|h| h.eq_ignore_ascii_case(s)),
            _ => false,
        })
    }

    /// 폴더의 Gmail 확장 속성(UID별). 별도 연결로 직접 명령을 보낸다(`gmail_ext::fetch_attrs` 참고).
    fn fetch_gmail_attrs(
        &self,
        folder_key: &str,
        uids: &[u32],
    ) -> Result<HashMap<u32, GmailAttrs>, ProviderError> {
        gmail_ext::fetch_attrs(
            self.open_tls()?,
            &self.email,
            &self.password,
            folder_key,
            uids,
        )
        .map_err(|e| match e {
            gmail_ext::RawError::LoginRejected => ProviderError::Auth(self.config.auth_hint.into()),
            gmail_ext::RawError::Failed(m) => ProviderError::Network(m),
        })
    }

    fn list_folders_blocking(&self) -> Result<Vec<RemoteFolder>, ProviderError> {
        let mut session = self.connect()?;
        let names = session.list(Some(""), Some("*")).map_err(map_imap_error)?;
        let raw: Vec<RawFolder> = names
            .iter()
            .filter(|n| {
                !n.attributes()
                    .contains(&imap::types::NameAttribute::NoSelect)
                    && !self.is_hidden(n.attributes())
            })
            .map(|n| {
                let decoded = utf7::decode(n.name());
                let kind = self.classify(n.attributes(), &decoded);
                (
                    n.name().to_string(),
                    decoded,
                    n.delimiter().map(String::from),
                    kind,
                )
            })
            .collect();
        let _ = session.logout();
        Ok(build_folders(raw))
    }

    fn fetch_blocking(
        &self,
        folder_key: &str,
        limit: usize,
    ) -> Result<Vec<RemoteMessage>, ProviderError> {
        let mut session = self.connect()?;
        session.examine(folder_key).map_err(map_imap_error)?;
        let mut uids: Vec<u32> = session
            .uid_search("ALL")
            .map_err(map_imap_error)?
            .into_iter()
            .collect();
        uids.sort_unstable_by(|a, b| b.cmp(a));
        uids.truncate(limit);

        let mut gmail = if self.config.gmail_extensions {
            self.fetch_gmail_attrs(folder_key, &uids)?
        } else {
            HashMap::new()
        };
        let mut messages = Vec::with_capacity(uids.len());
        for chunk in uids.chunks(FETCH_CHUNK) {
            let set = chunk
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",");
            let fetches = session
                .uid_fetch(&set, "(UID FLAGS INTERNALDATE BODY.PEEK[])")
                .map_err(map_imap_error)?;
            for f in fetches.iter() {
                let (Some(uid), Some(raw)) = (f.uid, f.body()) else {
                    continue;
                };
                let flags = f.flags();
                let mut message = parse_message(&FetchedMessage {
                    uid,
                    raw,
                    unread: !flags.contains(&imap::types::Flag::Seen),
                    starred: flags.contains(&imap::types::Flag::Flagged),
                    internal_date: f.internal_date().map_or(0, |d| d.timestamp()),
                });
                if let Some(attrs) = gmail.remove(&uid) {
                    message.thread_id = attrs.thrid;
                    message.dedupe_key = attrs.msgid;
                    message.label = attrs.labels.first().map(|l| (l.clone(), label_color(l)));
                }
                messages.push(message);
            }
        }
        messages.sort_by_key(|m| std::cmp::Reverse(m.received_at));
        let _ = session.logout();
        Ok(messages)
    }
}

#[async_trait]
impl MailProvider for ImapProvider {
    /// 접속과 로그인만 해 본다. 계정 추가 시 자격 증명 확인용.
    async fn verify(&self) -> Result<(), ProviderError> {
        self.blocking(|this| {
            let mut session = this.connect()?;
            let _ = session.logout();
            Ok(())
        })
        .await
    }

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, ProviderError> {
        self.blocking(|this| this.list_folders_blocking()).await
    }

    async fn fetch_messages(
        &self,
        folder_key: &str,
        limit: usize,
    ) -> Result<Vec<RemoteMessage>, ProviderError> {
        let key = folder_key.to_string();
        self.blocking(move |this| this.fetch_blocking(&key, limit))
            .await
    }
}

fn network(e: std::io::Error) -> ProviderError {
    ProviderError::Network(e.to_string())
}

fn map_imap_error(e: imap::Error) -> ProviderError {
    match e {
        imap::Error::No(m) | imap::Error::Bad(m) => ProviderError::Network(m),
        other => ProviderError::Network(other.to_string()),
    }
}

/// 라벨 이름으로 정하는 칩 색(1~8). 같은 이름이면 언제나 같은 색이다.
fn label_color(name: &str) -> u8 {
    let hash = name
        .bytes()
        .fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(u32::from(b)));
    (hash % 8) as u8 + 1
}

/// 받은편지함, 임시보관함 같은 기본 폴더를 앞에 두고 나머지는 서버 순서를 유지한다.
/// 전체보관함은 맨 뒤다: 중복 메일은 먼저 저장된 폴더가 차지하므로 라벨 폴더가 먼저 채워져야 한다.
fn build_folders(raw: Vec<RawFolder>) -> Vec<RemoteFolder> {
    let paths: HashSet<&str> = raw.iter().map(|(_, d, _, _)| d.as_str()).collect();
    let mut folders: Vec<RemoteFolder> = raw
        .iter()
        .map(|(key, decoded, delim, kind)| {
            let sep = delim.as_deref().unwrap_or("/");
            // 목록에 없는 상위(`[Gmail]` 같은 \Noselect 폴더)는 깊이에 세지 않는다.
            let depth = decoded
                .match_indices(sep)
                .filter(|(i, _)| paths.contains(&decoded[..*i]))
                .count();
            let name = decoded.rsplit(sep).next().unwrap_or(decoded);
            let prefix = format!("{decoded}{sep}");
            RemoteFolder {
                key: key.clone(),
                name: name.to_string(),
                kind: *kind,
                color_index: None,
                depth: depth.min(u8::MAX as usize) as u8,
                expandable: paths.iter().any(|p| p.starts_with(&prefix)),
            }
        })
        .collect();
    folders.sort_by_key(|f| match f.kind {
        FolderKind::Inbox => 0,
        FolderKind::Drafts => 1,
        FolderKind::Sent => 2,
        FolderKind::Spam => 3,
        FolderKind::Trash => 4,
        FolderKind::All => 6,
        _ => 5,
    });
    folders
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(key: &str, kind: FolderKind) -> RawFolder {
        (key.into(), utf7::decode(key), Some("/".into()), kind)
    }

    #[test]
    fn 한글_폴더명을_디코딩해_목록을_만든다() {
        let folders = build_folders(vec![
            raw("프로젝트", FolderKind::Folder),
            raw("&vPSwuLpUx3w-", FolderKind::Sent),
            raw("INBOX", FolderKind::Inbox),
        ]);
        assert_eq!(folders[0].kind, FolderKind::Inbox);
        assert_eq!(folders[1].name, "보낸메일");
        assert_eq!(folders[1].key, "&vPSwuLpUx3w-");
    }

    #[test]
    fn gmail_특수_폴더는_상위가_없으면_깊이_0이고_전체보관함은_맨_뒤다() {
        let folders = build_folders(vec![
            raw("[Gmail]/All Mail", FolderKind::All),
            raw("출장", FolderKind::Folder),
            raw("[Gmail]/Sent Mail", FolderKind::Sent),
            raw("INBOX", FolderKind::Inbox),
        ]);
        let names: Vec<_> = folders.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["INBOX", "Sent Mail", "출장", "All Mail"]);
        assert!(folders.iter().all(|f| f.depth == 0 && !f.expandable));
    }

    #[test]
    fn 라벨_색은_이름마다_고정이고_1에서_8_사이다() {
        assert_eq!(label_color("Work"), label_color("Work"));
        for name in ["Work", "여행", "a", ""] {
            assert!((1..=8).contains(&label_color(name)));
        }
    }

    #[test]
    fn 하위_폴더는_깊이와_펼침_여부를_가진다() {
        let folders = build_folders(vec![
            raw("INBOX", FolderKind::Inbox),
            raw("회사", FolderKind::Folder),
            raw("회사/2024", FolderKind::Folder),
        ]);
        let parent = folders.iter().find(|f| f.name == "회사").unwrap();
        let child = folders.iter().find(|f| f.name == "2024").unwrap();
        assert!(parent.expandable);
        assert_eq!((parent.depth, child.depth), (0, 1));
        assert!(!child.expandable);
    }
}
