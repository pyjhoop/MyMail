//! 테스트·개발용 가짜 서버. 같은 입력이면 항상 같은 결과를 돌려준다.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;

use super::{
    FolderKind, FolderSnapshot, FolderStatus, MailProvider, OutgoingMail, ProviderError,
    RemoteAttachment, RemoteFlags, RemoteFolder, RemoteMessage, WakeReason,
};

const SENDERS: [(&str, &str); 6] = [
    ("김도윤", "doyun.kim@gmail.com"),
    ("한빛이사 상담팀", "help@hanbit-move.kr"),
    ("이서연", "seoyeon@naver.com"),
    ("토스뱅크", "noreply@toss.im"),
    ("쿠팡", "no-reply@coupang.com"),
    ("GeekNews", "news@geeknews.io"),
];

const SUBJECTS: [&str; 6] = [
    "10월 가족여행 일정표랑 항공권 보내줄게",
    "이사 견적 요청드립니다 (11/15, 망원동 → 성산동)",
    "Re: 이번 주 토요일 북한산 갈래?",
    "10월 카드 명세서가 도착했습니다",
    "주문하신 상품이 배송 출발했어요",
    "이번 주 개발 뉴스 요약",
];

const BODIES: [&str; 6] = [
    "준호야,\n\n항공권 예매 끝났어! 10월 23일(금) 김포 → 제주 19:20 출발이고, 돌아오는 건 26일(월) 오후 2시 비행기야.\n\n숙소는 애월 쪽 독채로 잡았고 체크인은 오후 4시부터래.\n\n렌터카 예약되면 확인 메일 전달해 줘!\n도윤",
    "안녕하세요, 견적 요청 주신 내용 확인했습니다.\n\n방문 상담 가능한 시간대를 알려주시면 일정 조율해 드리겠습니다.",
    "토요일 아침 8시에 불광역에서 보면 어때?\n\n날씨 괜찮을 것 같아서 가볍게 다녀오자.",
    "이번 달 결제 예정 금액과 상세 내역을 확인해 보세요.",
    "택배가 오늘 중으로 도착할 예정입니다.\n\n문 앞에 두고 가겠습니다.",
    "이번 주에 읽을 만한 글 12개를 골랐어요.",
];

const ATTACHMENTS: [(&str, u64); 3] = [
    ("제주여행_일정표.pdf", 1_250_000),
    ("항공권_전자티켓.pdf", 384_000),
    ("숙소_외관.jpg", 2_400_000),
];

/// 서버 쪽 폴더 하나. UID는 올라가기만 하고 재사용하지 않는다.
struct FakeFolder {
    uid_validity: u32,
    next_uid: u32,
    messages: Vec<RemoteMessage>,
}

#[derive(Default)]
struct FakeServer {
    folders: HashMap<String, FakeFolder>,
    /// true면 모든 호출이 네트워크 오류로 실패한다.
    offline: bool,
    /// 서버가 받은 조작 기록 (`seen:inbox:3:true` 같은 꼴)
    ops: Vec<String>,
    /// 서버가 받아 보낸 메일
    sent: Vec<OutgoingMail>,
}

/// 메모리 안의 가짜 서버. 처음 상태는 항상 같고, 조작(읽음·이동·삭제)이 상태에 반영된다.
pub struct FakeProvider {
    /// 가장 최근 메일의 시각(유닉스 초). 나머지는 여기서 과거로 간다.
    now: i64,
    /// 계정마다 내용이 달라지도록 섞는 값
    offset: usize,
    server: Mutex<FakeServer>,
}

impl FakeProvider {
    pub fn new(now: i64, inbox_count: usize, offset: usize) -> Self {
        let provider = Self {
            now,
            offset,
            server: Mutex::new(FakeServer::default()),
        };
        let folders = provider
            .folder_list()
            .into_iter()
            .map(|f| {
                let total = match f.key.as_str() {
                    "inbox" => inbox_count,
                    "sent" | "drafts" | "spam" | "trash" => 3,
                    _ => 2,
                };
                let messages: Vec<_> = (0..total).map(|i| provider.message(&f.key, i)).collect();
                let folder = FakeFolder {
                    uid_validity: 1,
                    next_uid: total as u32,
                    messages,
                };
                (f.key, folder)
            })
            .collect();
        provider.server().folders = folders;
        provider
    }

    fn server(&self) -> MutexGuard<'_, FakeServer> {
        self.server.lock().expect("fake server lock")
    }

    /// 연결이 끊긴 상태를 흉내 낸다.
    pub fn set_offline(&self, offline: bool) {
        self.server().offline = offline;
    }

    /// 서버가 받은 조작 기록
    pub fn ops(&self) -> Vec<String> {
        self.server().ops.clone()
    }

    /// 보내진 메일
    pub fn sent_mails(&self) -> Vec<OutgoingMail> {
        self.server().sent.clone()
    }

    /// 새 메일이 도착한 것처럼 폴더에 한 통 넣는다. 새 UID를 돌려준다.
    pub fn deliver(&self, folder_key: &str, subject: &str) -> String {
        let mut message = self.message(folder_key, 0);
        message.subject = subject.into();
        message.received_at = self.now + 60;
        message.unread = true;
        let mut server = self.server();
        let folder = server.folders.get_mut(folder_key).expect("folder");
        message.remote_id = folder.next_uid.to_string();
        folder.next_uid += 1;
        let id = message.remote_id.clone();
        folder.messages.push(message);
        id
    }

    /// 다른 기기에서 지운 것처럼 서버에서 메일을 없앤다.
    pub fn remove(&self, folder_key: &str, remote_id: &str) {
        if let Some(f) = self.server().folders.get_mut(folder_key) {
            f.messages.retain(|m| m.remote_id != remote_id);
        }
    }

    /// 다른 기기에서 읽음 표시를 바꾼 것처럼 서버의 플래그를 고친다.
    pub fn set_unread(&self, folder_key: &str, remote_id: &str, unread: bool) {
        if let Some(m) = self
            .server()
            .folders
            .get_mut(folder_key)
            .and_then(|f| f.messages.iter_mut().find(|m| m.remote_id == remote_id))
        {
            m.unread = unread;
        }
    }

    /// 서버가 UID를 새로 매겼다고 가정한다(UIDVALIDITY 변경).
    pub fn renumber(&self, folder_key: &str) {
        if let Some(f) = self.server().folders.get_mut(folder_key) {
            f.uid_validity += 1;
            for (i, m) in f.messages.iter_mut().enumerate() {
                m.remote_id = (i as u32 + 1000).to_string();
            }
        }
    }

    fn with_folder<T>(
        &self,
        folder_key: &str,
        record: String,
        work: impl FnOnce(&mut FakeFolder) -> Result<T, ProviderError>,
    ) -> Result<T, ProviderError> {
        let mut server = self.server();
        if server.offline {
            return Err(ProviderError::Network("연결 끊김".into()));
        }
        server.ops.push(record);
        let folder = server
            .folders
            .get_mut(folder_key)
            .ok_or_else(|| ProviderError::NotFound(folder_key.into()))?;
        work(folder)
    }

    fn check_online(&self) -> Result<(), ProviderError> {
        if self.server().offline {
            return Err(ProviderError::Network("연결 끊김".into()));
        }
        Ok(())
    }

    fn folder_list(&self) -> Vec<RemoteFolder> {
        let mut folders = vec![
            Self::folder("inbox", "받은편지함", FolderKind::Inbox),
            Self::folder("sent", "보낸편지함", FolderKind::Sent),
            Self::folder("drafts", "임시보관함", FolderKind::Drafts),
            Self::folder("spam", "스팸", FolderKind::Spam),
            Self::folder("trash", "휴지통", FolderKind::Trash),
        ];
        if self.offset == 0 {
            for (key, name, color) in [
                ("l-family", "가족", 5),
                ("l-travel", "여행", 6),
                ("l-finance", "금융", 7),
            ] {
                folders.push(RemoteFolder {
                    color_index: Some(color),
                    ..Self::folder(key, name, FolderKind::Label)
                });
            }
            folders.push(RemoteFolder {
                expandable: true,
                ..Self::folder("f-move", "이사 준비", FolderKind::Folder)
            });
            folders.push(RemoteFolder {
                depth: 1,
                ..Self::folder("f-contract", "계약·서류", FolderKind::Folder)
            });
        }
        folders
    }

    fn folder(key: &str, name: &str, kind: FolderKind) -> RemoteFolder {
        RemoteFolder {
            key: key.into(),
            name: name.into(),
            kind,
            color_index: None,
            depth: 0,
            expandable: false,
        }
    }

    fn message(&self, folder_key: &str, i: usize) -> RemoteMessage {
        let k = (i + self.offset) % SENDERS.len();
        let (sender, sender_email) = SENDERS[k];
        let body = BODIES[k];
        let has_attachment = i.is_multiple_of(5);
        RemoteMessage {
            remote_id: i.to_string(),
            // 세 통씩 묶어 한 스레드로 만든다 (한 묶음 건너 하나).
            dedupe_key: None,
            thread_id: (i / 3)
                .is_multiple_of(2)
                .then(|| format!("{folder_key}-t{}", i / 3)),
            sender: sender.into(),
            sender_email: sender_email.into(),
            recipients: "나".into(),
            subject: SUBJECTS[k].into(),
            body: body.into(),
            html: None,
            inline_images: Vec::new(),
            // 최근 두 건은 몇 시간 간격, 이후로는 하루 단위로 멀어진다.
            received_at: self.now - (i as i64) * 3 * 3600,
            unread: i.is_multiple_of(4),
            starred: i.is_multiple_of(7),
            label: (i.is_multiple_of(3) && self.offset == 0).then(|| ("여행".to_string(), 6)),
            attachments: if has_attachment {
                ATTACHMENTS
                    .iter()
                    .map(|(name, size)| RemoteAttachment {
                        name: (*name).into(),
                        size: *size,
                    })
                    .collect()
            } else {
                Vec::new()
            },
        }
    }
}

#[async_trait]
impl MailProvider for FakeProvider {
    async fn verify(&self) -> Result<(), ProviderError> {
        self.check_online()
    }

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, ProviderError> {
        self.check_online()?;
        Ok(self.folder_list())
    }

    async fn fetch_messages(
        &self,
        folder_key: &str,
        limit: usize,
    ) -> Result<Vec<RemoteMessage>, ProviderError> {
        self.with_folder(folder_key, format!("fetch:{folder_key}"), |f| {
            let mut messages = f.messages.clone();
            messages.sort_by_key(|m| std::cmp::Reverse(m.received_at));
            messages.truncate(limit);
            Ok(messages)
        })
    }

    async fn snapshot(&self, folder_key: &str) -> Result<FolderSnapshot, ProviderError> {
        self.with_folder(folder_key, format!("snapshot:{folder_key}"), |f| {
            Ok(FolderSnapshot {
                uid_validity: Some(f.uid_validity),
                messages: f
                    .messages
                    .iter()
                    .map(|m| RemoteFlags {
                        remote_id: m.remote_id.clone(),
                        unread: m.unread,
                        starred: m.starred,
                    })
                    .collect(),
            })
        })
    }

    async fn fetch_by_ids(
        &self,
        folder_key: &str,
        ids: &[String],
    ) -> Result<Vec<RemoteMessage>, ProviderError> {
        self.with_folder(folder_key, format!("fetch_ids:{folder_key}"), |f| {
            Ok(f.messages
                .iter()
                .filter(|m| ids.contains(&m.remote_id))
                .cloned()
                .collect())
        })
    }

    async fn set_seen(
        &self,
        folder_key: &str,
        remote_id: &str,
        seen: bool,
    ) -> Result<(), ProviderError> {
        self.with_folder(
            folder_key,
            format!("seen:{folder_key}:{remote_id}:{seen}"),
            |f| {
                let m = find(f, remote_id)?;
                m.unread = !seen;
                Ok(())
            },
        )
    }

    async fn set_flagged(
        &self,
        folder_key: &str,
        remote_id: &str,
        flagged: bool,
    ) -> Result<(), ProviderError> {
        self.with_folder(
            folder_key,
            format!("flagged:{folder_key}:{remote_id}:{flagged}"),
            |f| {
                let m = find(f, remote_id)?;
                m.starred = flagged;
                Ok(())
            },
        )
    }

    async fn move_message(
        &self,
        folder_key: &str,
        remote_id: &str,
        dest_key: &str,
    ) -> Result<(), ProviderError> {
        let mut server = self.server();
        if server.offline {
            return Err(ProviderError::Network("연결 끊김".into()));
        }
        server
            .ops
            .push(format!("move:{folder_key}:{remote_id}:{dest_key}"));
        if !server.folders.contains_key(dest_key) {
            return Err(ProviderError::Rejected(format!("없는 폴더: {dest_key}")));
        }
        let source = server
            .folders
            .get_mut(folder_key)
            .ok_or_else(|| ProviderError::NotFound(folder_key.into()))?;
        let at = source
            .messages
            .iter()
            .position(|m| m.remote_id == remote_id)
            .ok_or_else(|| ProviderError::Rejected(format!("없는 메일: {remote_id}")))?;
        let mut message = source.messages.remove(at);
        let dest = server.folders.get_mut(dest_key).expect("checked above");
        message.remote_id = dest.next_uid.to_string();
        dest.next_uid += 1;
        dest.messages.push(message);
        Ok(())
    }

    async fn delete_message(&self, folder_key: &str, remote_id: &str) -> Result<(), ProviderError> {
        self.with_folder(
            folder_key,
            format!("delete:{folder_key}:{remote_id}"),
            |f| {
                find(f, remote_id)?;
                f.messages.retain(|m| m.remote_id != remote_id);
                Ok(())
            },
        )
    }

    async fn send(&self, mail: &OutgoingMail) -> Result<(), ProviderError> {
        let mut server = self.server();
        if server.offline {
            return Err(ProviderError::Network("연결 끊김".into()));
        }
        server.sent.push(mail.clone());
        Ok(())
    }

    async fn folder_statuses(
        &self,
        folder_keys: &[String],
    ) -> Result<HashMap<String, FolderStatus>, ProviderError> {
        let mut server = self.server();
        if server.offline {
            return Err(ProviderError::Network("연결 끊김".into()));
        }
        server.ops.push("statuses".into());
        Ok(folder_keys
            .iter()
            .filter_map(|key| Some((key.clone(), status_of(server.folders.get(key)?))))
            .collect())
    }

    async fn wait_for_changes(
        &self,
        folder_key: &str,
        _timeout: Duration,
        since: Option<&FolderStatus>,
    ) -> Result<WakeReason, ProviderError> {
        self.check_online()?;
        let changed = since.is_some_and(|since| {
            self.server()
                .folders
                .get(folder_key)
                .is_some_and(|f| status_of(f) != *since)
        });
        Ok(if changed {
            WakeReason::Changed
        } else {
            WakeReason::TimedOut
        })
    }
}

fn status_of(folder: &FakeFolder) -> FolderStatus {
    FolderStatus {
        uid_validity: Some(folder.uid_validity),
        uid_next: Some(folder.next_uid),
        messages: folder.messages.len() as u32,
        unseen: folder.messages.iter().filter(|m| m.unread).count() as u32,
    }
}

fn find<'a>(
    folder: &'a mut FakeFolder,
    remote_id: &str,
) -> Result<&'a mut RemoteMessage, ProviderError> {
    folder
        .messages
        .iter_mut()
        .find(|m| m.remote_id == remote_id)
        .ok_or_else(|| ProviderError::Rejected(format!("없는 메일: {remote_id}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn 폴더_목록은_받은편지함을_포함한다() {
        let p = FakeProvider::new(1_000_000, 10, 0);
        let folders = p.list_folders().await.unwrap();
        assert!(folders.iter().any(|f| f.kind == FolderKind::Inbox));
        assert!(folders.iter().any(|f| f.kind == FolderKind::Label));
    }

    #[tokio::test]
    async fn 메일은_최신순이고_limit을_지킨다() {
        let p = FakeProvider::new(1_000_000, 10, 0);
        let msgs = p.fetch_messages("inbox", 4).await.unwrap();
        assert_eq!(msgs.len(), 4);
        assert!(msgs.windows(2).all(|w| w[0].received_at > w[1].received_at));
    }

    #[tokio::test]
    async fn 없는_폴더는_오류다() {
        let p = FakeProvider::new(0, 1, 0);
        assert!(matches!(
            p.fetch_messages("nope", 1).await,
            Err(ProviderError::NotFound(_))
        ));
    }
}
