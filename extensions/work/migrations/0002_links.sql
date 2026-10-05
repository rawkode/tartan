-- tartan.work (repo scope): the change a claim was submitted as, the landed commit of an item, and negative knowledge
-- passed through from selection@1 (WP12).
ALTER TABLE claims ADD COLUMN change_id TEXT;
ALTER TABLE items ADD COLUMN landed_commit TEXT;
CREATE INDEX claims_lane ON claims(lane_id);
CREATE INDEX claims_change ON claims(change_id);
CREATE INDEX items_commit ON items(landed_commit);
CREATE TABLE knowledge (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}', at INTEGER NOT NULL);
CREATE INDEX knowledge_item ON knowledge(item_id);
