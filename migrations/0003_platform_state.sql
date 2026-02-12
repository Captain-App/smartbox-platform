-- User registry (replaces hardcoded array in src/lib/user-registry.ts)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    telegram_handle TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    tier INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Seed from current hardcoded registry + tier assignments
INSERT OR IGNORE INTO users (id, name, full_name, agent_name, telegram_handle, status, tier) VALUES
  ('32c7100e-c6ce-4cf8-8b64-edf4ac3b760b','jack','Jack Lippold','sable','captainoftheclawd_bot','active',3),
  ('81bf6a68-28fe-48ef-b257-f9ad013e6298','josh','Joshua Carey','kestrel','davy_jones_hunts_bot','active',2),
  ('fe56406b-a723-43cf-9f19-ba2ffcb135b0','miles','Miles','miles',NULL,'active',2),
  ('38b1ec2b-7a70-4834-a48d-162b8902b0fd','kyla','Kyla Warder','echo',NULL,'active',1),
  ('0f1195c1-6b57-4254-9871-6ef3b7fa360c','rhys','Rhys Meredith','claw',NULL,'active',1),
  ('e29fd082-6811-4e29-893e-64699c49e1f0','ben_lippold','Ben Lippold','echo7',NULL,'active',1),
  ('6d575ef4-7ac8-4a17-b732-e0e690986e58','david_geddes','David Geddes','wisp',NULL,'active',1),
  ('aef3677b-afdf-4a7e-bbeb-c596f0d94d29','adnan','Adnan Khan','adnan',NULL,'active',1),
  ('5bb7d208-2baf-4c95-8aec-f28e016acedb','david_lippold','David Lippold','david',NULL,'active',3),
  ('f1647b02-c311-49c3-9c72-48b8fc5da350','joe_james','Joe James','joe',NULL,'active',1),
  ('679f60a6-2e00-403b-86f1-f4696149294f','james_old','Joshua Carey (old container)','old',NULL,'deleted',1);

-- Health state (replaces in-memory healthStates Map in health.ts)
CREATE TABLE IF NOT EXISTS health_states (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_check TEXT,
    last_healthy TEXT,
    last_restart TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Circuit breaker (replaces in-memory restartCounts Map in health.ts)
CREATE TABLE IF NOT EXISTS circuit_breaker (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    restart_count INTEGER NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Sync history (replaces in-memory recentSyncResults Map in sync.ts)
CREATE TABLE IF NOT EXISTS sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    success INTEGER NOT NULL,
    sync_id TEXT,
    duration_ms INTEGER,
    file_count INTEGER,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_history_user ON sync_history(user_id, created_at DESC);
