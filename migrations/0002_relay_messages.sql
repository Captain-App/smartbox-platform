-- Relay messages table (replaces KV for message storage)
CREATE TABLE IF NOT EXISTS relay_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  bot_name TEXT,
  message_id INTEGER NOT NULL,
  text TEXT,
  timestamp INTEGER NOT NULL,
  reply_to_message_id INTEGER,
  thread_id TEXT,
  media_url TEXT,
  media_type TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for efficient polling (group + timestamp descending)
CREATE INDEX IF NOT EXISTS idx_relay_group_ts ON relay_messages(group_id, timestamp DESC);

-- Index for deduplication check
CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_unique ON relay_messages(group_id, bot_id, message_id);
