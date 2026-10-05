-- tartan.ci (repo scope): plans, checks, result cache.
CREATE TABLE plans (subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, sha TEXT NOT NULL, run_id TEXT,
  jobs_json TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (subject_kind, subject_id, sha));
CREATE TABLE checks (subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, sha TEXT NOT NULL, context TEXT NOT NULL,
  state TEXT NOT NULL, run_id TEXT, cached INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject_kind, subject_id, sha, context));
-- Successful jobs only.
CREATE TABLE cache (input_hash TEXT PRIMARY KEY, job_id TEXT NOT NULL, project TEXT, run_id TEXT NOT NULL, at INTEGER NOT NULL);
