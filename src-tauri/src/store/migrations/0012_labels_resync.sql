-- 라벨 도입 전에 받은 메일의 라벨을 서버에서 다시 읽었는지(1 = 끝남). 계정마다 한 번만 전체를 훑는다.
ALTER TABLE accounts ADD COLUMN labels_synced INTEGER NOT NULL DEFAULT 0;
