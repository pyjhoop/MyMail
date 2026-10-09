-- 작성·발송. 서명과 임시보관함(작성 중인 메일), 보내지 못한 메일.

-- 계정별 서명(일반 텍스트). 새 메일·답장 본문에 자동으로 넣는다.
ALTER TABLE accounts ADD COLUMN signature TEXT NOT NULL DEFAULT '';

-- 작성 중이거나 아직 보내지 못한 메일. 서버의 임시보관함에는 올리지 않고 이 앱 안에만 둔다.
-- 보내기에 성공하면 지운다. 실패하면 status = 'failed'로 남겨 다시 보낼 수 있게 한다.
CREATE TABLE compose_mails (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- 받는 사람 목록. JSON 배열이고 항목은 "이름 <주소>" 또는 "주소"
    to_addrs   TEXT NOT NULL DEFAULT '[]',
    cc_addrs   TEXT NOT NULL DEFAULT '[]',
    bcc_addrs  TEXT NOT NULL DEFAULT '[]',
    subject    TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    -- 'draft' | 'failed'
    status     TEXT NOT NULL DEFAULT 'draft',
    error      TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_compose_account ON compose_mails(account_id, updated_at DESC);

CREATE TABLE compose_attachments (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    mail_id TEXT NOT NULL REFERENCES compose_mails(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    mime    TEXT NOT NULL,
    data    BLOB NOT NULL
);
CREATE INDEX idx_compose_attachments_mail ON compose_attachments(mail_id);
