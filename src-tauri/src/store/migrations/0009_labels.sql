-- 메일에 붙은 라벨 전체(JSON 문자열 배열). 예전 행은 NULL이고 label_name(첫 라벨)으로 대신한다.
ALTER TABLE messages ADD COLUMN labels TEXT;
