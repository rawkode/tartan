-- tartan.board (node scope): boards, columns, cards.
CREATE TABLE boards (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, name TEXT NOT NULL);
-- auto_rule: 'work.claimed' | 'changes.submitted' | 'queue.batched' | 'changes.landed'
CREATE TABLE columns (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL, wip INTEGER,
  auto_rule TEXT);
-- rank is a fractional index.
CREATE TABLE cards (ref TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_id TEXT NOT NULL, rank TEXT NOT NULL,
  title TEXT NOT NULL, badges_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);
