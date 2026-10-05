-- tartan.review (repo scope): owner rules, reviews, attention set, track record.
-- rules come from .tartan/owners.yaml AT TRUNK only (K13); refreshed on ref.advanced.
CREATE TABLE rules (glob TEXT PRIMARY KEY, sensitivity INTEGER NOT NULL, owners_json TEXT NOT NULL,
  trunk_sha TEXT NOT NULL);
CREATE TABLE reviews (change_id TEXT NOT NULL, n INTEGER NOT NULL, risk REAL NOT NULL, factors_json TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('auto','human')), decision TEXT, decided_by TEXT, evidence_json TEXT NOT NULL,
  shadow INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY (change_id, n, shadow));
CREATE TABLE attention (change_id TEXT NOT NULL, principal_id TEXT NOT NULL, reason TEXT NOT NULL, since INTEGER NOT NULL,
  PRIMARY KEY (change_id, principal_id));
CREATE TABLE track (principal_id TEXT PRIMARY KEY, landed INTEGER NOT NULL DEFAULT 0, ejected INTEGER NOT NULL DEFAULT 0,
  vetoed INTEGER NOT NULL DEFAULT 0, reverted INTEGER NOT NULL DEFAULT 0);
