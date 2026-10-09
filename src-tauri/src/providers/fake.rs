//! 테스트·개발용 가짜 서버. 같은 입력이면 항상 같은 결과를 돌려준다.

use async_trait::async_trait;

use super::{
    FolderKind, MailProvider, ProviderError, RemoteAttachment, RemoteFolder, RemoteMessage,
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

pub struct FakeProvider {
    /// 가장 최근 메일의 시각(유닉스 초). 나머지는 여기서 과거로 간다.
    now: i64,
    inbox_count: usize,
    /// 계정마다 내용이 달라지도록 섞는 값
    offset: usize,
}

impl FakeProvider {
    pub fn new(now: i64, inbox_count: usize, offset: usize) -> Self {
        Self {
            now,
            inbox_count,
            offset,
        }
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
        Ok(())
    }

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, ProviderError> {
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
        Ok(folders)
    }

    async fn fetch_messages(
        &self,
        folder_key: &str,
        limit: usize,
    ) -> Result<Vec<RemoteMessage>, ProviderError> {
        let total = match folder_key {
            "inbox" => self.inbox_count,
            "sent" | "drafts" | "spam" | "trash" => 3,
            k if k.starts_with("l-") || k.starts_with("f-") => 2,
            other => return Err(ProviderError::NotFound(other.into())),
        };
        Ok((0..total.min(limit))
            .map(|i| self.message(folder_key, i))
            .collect())
    }
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
