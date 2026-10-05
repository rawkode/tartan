-- acme.no-secrets (repo scope, the facet's own SQLite):
-- findings never hold a credential, only its masked form.
CREATE TABLE findings (change_id TEXT, lane_id TEXT, path TEXT NOT NULL, line INTEGER NOT NULL, kind TEXT NOT NULL,
  masked TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('gate','echo')), at INTEGER NOT NULL);
-- The same finding from the same source and change or lane is stored once.
CREATE UNIQUE INDEX findings_once ON findings(source, COALESCE(change_id, ''), COALESCE(lane_id, ''), path, line, kind);
CREATE INDEX findings_change ON findings(change_id);
CREATE INDEX findings_at ON findings(at);
CREATE TABLE decisions (id TEXT PRIMARY KEY, point TEXT NOT NULL, change_id TEXT, verdict TEXT NOT NULL,
  message TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX decisions_change ON decisions(change_id, at);
