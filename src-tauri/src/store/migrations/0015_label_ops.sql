-- 폴더(라벨)의 전체 이름(`부모/자식`). 메일에 붙은 라벨 이름과 맞춰 본다. 예전 행은 NULL이고 name으로 대신한다.
ALTER TABLE folders ADD COLUMN path TEXT;
