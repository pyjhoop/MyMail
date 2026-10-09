-- 정제 전 원문 HTML. 텍스트 본문(body)은 미리보기·검색용으로 그대로 둔다.
ALTER TABLE messages ADD COLUMN html TEXT;

-- HTML 본문이 cid:로 가리키는 인라인 이미지. 첨부 목록(attachments)과 별개다.
CREATE TABLE inline_images (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    content_id TEXT NOT NULL,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    PRIMARY KEY (message_id, content_id)
);
