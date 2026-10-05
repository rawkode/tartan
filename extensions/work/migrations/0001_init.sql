-- tartan.work (repo scope): work items, claims, comments.
CREATE TABLE items (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('issue','intent','resolve')), title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '',
  acceptance_json TEXT NOT NULL DEFAULT '[]', footprint_json TEXT NOT NULL DEFAULT '{"projects":[],"prefixes":[]}',
  parent_ref TEXT, origin_json TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single','tournament')), k INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('open','claimed','in_review','done','abandoned')),
  priority INTEGER NOT NULL DEFAULT 2, labels_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
-- External-content FTS index; kept in sync by the extension code, not by triggers.
CREATE VIRTUAL TABLE items_fts USING fts5(title, why, content='items', content_rowid='rowid');
CREATE TABLE claims (item_id TEXT NOT NULL, lane_id TEXT NOT NULL, principal_id TEXT NOT NULL, candidate INTEGER,
  state TEXT NOT NULL CHECK (state IN ('active','submitted','won','lost','released','landed','lease_lost')),
  plan TEXT, claimed_at INTEGER NOT NULL, ended_at INTEGER, PRIMARY KEY (item_id, lane_id));
CREATE TABLE comments (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, author_id TEXT NOT NULL, body_md TEXT NOT NULL, at INTEGER NOT NULL);
