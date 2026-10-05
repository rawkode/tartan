-- tartan.board (node scope): the repo of each card and the changes and lanes that point at a card, so queue and lane
-- events (which carry only a change or lane id) move the right card (WP12).
ALTER TABLE cards ADD COLUMN repo_id TEXT;
ALTER TABLE cards ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
CREATE INDEX cards_column ON cards(board_id, column_id, rank);
CREATE INDEX cards_repo ON cards(repo_id);
CREATE TABLE links (link_key TEXT PRIMARY KEY, ref TEXT NOT NULL);
