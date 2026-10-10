-- 설정 > 계정: 답장·전달에도 서명을 넣을지 (1 = 넣음)
ALTER TABLE accounts ADD COLUMN sign_replies INTEGER NOT NULL DEFAULT 1;
