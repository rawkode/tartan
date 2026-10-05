-- tartan.ci (repo scope): plan requests whose base's Tartan config (the
-- repository's package tartan, ADR repo config) was still evaluating; replayed
-- when its trunk row resolves (repo.config.resolved).
CREATE TABLE config_waits (subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, sha TEXT NOT NULL,
  request_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (subject_kind, subject_id, sha));
