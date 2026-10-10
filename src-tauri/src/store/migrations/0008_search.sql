-- 검색 개선. (1) FTS에 보낸 주소·받는 사람 열을 더해 from:/to: 연산자를 인덱스로 처리한다.
-- (2) 읽음·별표·첨부·기간 필터용 인덱스. (3) 보낸사람 추천용 집계 테이블.

DROP TRIGGER messages_ai;
DROP TRIGGER messages_ad;
DROP TRIGGER messages_au;
DROP TABLE messages_fts;

CREATE VIRTUAL TABLE messages_fts USING fts5(
    subject, sender, sender_email, recipients, body,
    content = 'messages', content_rowid = 'rowid',
    tokenize = 'unicode61', columnsize = 0
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, subject, sender, sender_email, recipients, body)
    VALUES (new.rowid, new.subject, new.sender, new.sender_email, new.recipients, new.body);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, sender, sender_email, recipients, body)
    VALUES ('delete', old.rowid, old.subject, old.sender, old.sender_email, old.recipients, old.body);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF subject, sender, sender_email, recipients, body ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, sender, sender_email, recipients, body)
    VALUES ('delete', old.rowid, old.subject, old.sender, old.sender_email, old.recipients, old.body);
    INSERT INTO messages_fts(rowid, subject, sender, sender_email, recipients, body)
    VALUES (new.rowid, new.subject, new.sender, new.sender_email, new.recipients, new.body);
END;

INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');

-- 필터만 있는 질의(is:안읽음 등)가 전체 스캔을 하지 않게 하는 인덱스.
CREATE INDEX idx_messages_received ON messages(received_at DESC, id);
-- 검색어에 일치하는 메일이 아주 많을 때 정렬 5종을 인덱스 순서로 걸어 첫 페이지에서 멈추기 위한 인덱스.
CREATE INDEX idx_messages_received_asc ON messages(received_at ASC, id);
CREATE INDEX idx_messages_sender ON messages(sender COLLATE NOCASE ASC, received_at DESC, id);
CREATE INDEX idx_messages_subject ON messages(subject COLLATE NOCASE ASC, received_at DESC, id);
CREATE INDEX idx_messages_unread_first ON messages(unread DESC, received_at DESC, id);
CREATE INDEX idx_messages_unread ON messages(received_at DESC, id) WHERE unread = 1;
CREATE INDEX idx_messages_starred ON messages(received_at DESC, id) WHERE starred = 1;
CREATE INDEX idx_messages_attachment ON messages(received_at DESC, id) WHERE has_attachment = 1;

-- 보낸사람 추천. 키 입력마다 messages를 GROUP BY 하지 않도록 메일이 들고 날 때 함께 갱신한다.
CREATE TABLE sender_stats (
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    sender_email TEXT NOT NULL,
    name         TEXT NOT NULL,
    mail_count   INTEGER NOT NULL,
    PRIMARY KEY (account_id, sender_email)
) WITHOUT ROWID;

INSERT INTO sender_stats (account_id, sender_email, name, mail_count)
SELECT account_id, sender_email, MAX(sender), COUNT(*)
FROM messages WHERE sender_email != '' GROUP BY account_id, sender_email;

CREATE TRIGGER sender_stats_ai AFTER INSERT ON messages WHEN new.sender_email != '' BEGIN
    INSERT INTO sender_stats (account_id, sender_email, name, mail_count)
    VALUES (new.account_id, new.sender_email, new.sender, 1)
    ON CONFLICT(account_id, sender_email) DO UPDATE SET mail_count = mail_count + 1, name = excluded.name;
END;
CREATE TRIGGER sender_stats_ad AFTER DELETE ON messages WHEN old.sender_email != '' BEGIN
    UPDATE sender_stats SET mail_count = mail_count - 1
    WHERE account_id = old.account_id AND sender_email = old.sender_email;
    DELETE FROM sender_stats
    WHERE account_id = old.account_id AND sender_email = old.sender_email AND mail_count <= 0;
END;
