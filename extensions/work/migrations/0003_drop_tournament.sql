-- tartan.work (repo scope): tournaments were removed. Drop the tournament-only columns (items.mode,
-- items.k, claims.candidate) and the negative-knowledge table; claims a tournament decided end as released. The
-- claims.state CHECK still lists 'won' and 'lost' (a CHECK change needs a table rebuild); nothing writes them.
UPDATE claims SET state = 'released', ended_at = COALESCE(ended_at, claimed_at) WHERE state IN ('won', 'lost');
ALTER TABLE items DROP COLUMN mode;
ALTER TABLE items DROP COLUMN k;
ALTER TABLE claims DROP COLUMN candidate;
DROP TABLE knowledge;
