-- tartan.hud (node scope): per-minute counters.
CREATE TABLE counters (minute INTEGER NOT NULL, metric TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (minute, metric));
