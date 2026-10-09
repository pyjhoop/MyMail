-- 폴더가 달라도 같은 메일(Gmail X-GM-MSGID)은 계정 안에서 한 번만 저장한다.
ALTER TABLE messages ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX idx_messages_dedupe ON messages(account_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
