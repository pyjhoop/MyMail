-- 설정 > 계정 > 알림: 계정별 알림 설정
ALTER TABLE accounts ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 1;
-- 알림 대상: inbox(받은편지함만) | all(모든 폴더) | starred(별표한 보낸사람만)
ALTER TABLE accounts ADD COLUMN notify_scope TEXT NOT NULL DEFAULT 'inbox';
ALTER TABLE accounts ADD COLUMN notify_sound INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN notify_badge INTEGER NOT NULL DEFAULT 1;

-- 앱 전체 설정(알림 일시 중지 만료 시각 등)
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
