-- 답장 인용을 본문과 따로 저장한다. 작성 중에는 `>` 없는 원문 그대로 두고, 보낼 때만 `> `를 붙인다.
ALTER TABLE compose_mails ADD COLUMN quote_header TEXT NOT NULL DEFAULT '';
ALTER TABLE compose_mails ADD COLUMN quote_text TEXT NOT NULL DEFAULT '';
