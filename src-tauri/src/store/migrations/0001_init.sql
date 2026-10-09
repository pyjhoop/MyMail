CREATE TABLE accounts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    provider    TEXT NOT NULL CHECK (provider IN ('gmail', 'naver')),
    color_index INTEGER NOT NULL,
    initial     TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE folders (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    color_index INTEGER,
    depth       INTEGER NOT NULL DEFAULT 0,
    expandable  INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_folders_account ON folders(account_id, position);

CREATE TABLE messages (
    id             TEXT PRIMARY KEY,
    account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id      TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    thread_id      TEXT,
    sender         TEXT NOT NULL,
    sender_email   TEXT NOT NULL,
    recipients     TEXT NOT NULL DEFAULT '',
    subject        TEXT NOT NULL,
    preview        TEXT NOT NULL DEFAULT '',
    body           TEXT NOT NULL DEFAULT '',
    received_at    INTEGER NOT NULL,
    unread         INTEGER NOT NULL DEFAULT 1,
    starred        INTEGER NOT NULL DEFAULT 0,
    has_attachment INTEGER NOT NULL DEFAULT 0,
    label_name     TEXT,
    label_color    INTEGER
);
CREATE INDEX idx_messages_folder ON messages(folder_id, received_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id, received_at);

CREATE TABLE attachments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    ext        TEXT NOT NULL
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

-- 외부 콘텐츠 FTS5: 본문은 messages에만 두고 인덱스만 따로 유지한다.
CREATE VIRTUAL TABLE messages_fts USING fts5(
    subject, sender, body,
    content = 'messages', content_rowid = 'rowid',
    tokenize = 'unicode61'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, subject, sender, body)
    VALUES (new.rowid, new.subject, new.sender, new.body);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, sender, body)
    VALUES ('delete', old.rowid, old.subject, old.sender, old.body);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF subject, sender, body ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, sender, body)
    VALUES ('delete', old.rowid, old.subject, old.sender, old.body);
    INSERT INTO messages_fts(rowid, subject, sender, body)
    VALUES (new.rowid, new.subject, new.sender, new.body);
END;
