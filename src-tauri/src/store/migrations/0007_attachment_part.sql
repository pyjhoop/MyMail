-- 첨부 내려받기. 첨부가 메일 원문에서 몇 번째 파트인지(part_index)와 MIME 종류를 기억한다.
-- 이미 저장된 메일은 part_index가 비어 있고, 내려받을 때 이름·크기로 찾는다.
ALTER TABLE attachments ADD COLUMN part_index INTEGER;
ALTER TABLE attachments ADD COLUMN mime TEXT NOT NULL DEFAULT '';
