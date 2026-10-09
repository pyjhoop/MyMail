-- 동기화 상태. 서버 UID와 로컬 메일을 대조하기 위한 기록과 오프라인 큐.

-- 서버 UID가 바뀌었는지 알아내는 값(UIDVALIDITY). 바뀌면 그 폴더의 로컬 사본을 버리고 다시 받는다.
ALTER TABLE folders ADD COLUMN uid_validity INTEGER;

-- 폴더에서 이미 받아 처리한 서버 UID. Gmail에서 다른 폴더가 차지해 저장하지 않은 중복 메일도 기록해,
-- 동기화할 때마다 다시 받지 않게 한다.
CREATE TABLE folder_uids (
    folder_id  TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    remote_id  TEXT NOT NULL,
    dedupe_key TEXT,
    PRIMARY KEY (folder_id, remote_id)
) WITHOUT ROWID;
CREATE INDEX idx_folder_uids_dedupe ON folder_uids(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- 이미 저장된 메일은 id가 `{폴더 id}-{UID}` 꼴이다.
INSERT INTO folder_uids (folder_id, remote_id, dedupe_key)
SELECT folder_id, substr(id, length(folder_id) + 2), dedupe_key FROM messages;

-- 서버에 아직 반영하지 못한 사용자 조작. 연결이 되면 만든 순서대로 보낸다.
CREATE TABLE pending_ops (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- 'seen' | 'flagged' | 'move' | 'delete'
    kind       TEXT NOT NULL,
    folder_key TEXT NOT NULL,
    remote_id  TEXT NOT NULL,
    -- seen·flagged: '1' 또는 '0', move: 대상 폴더 key
    arg        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_pending_ops_account ON pending_ops(account_id, id);
