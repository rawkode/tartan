-- tartan.changes (repo scope): tournaments were removed; drop the tournament-only selection_ref column.
ALTER TABLE changes DROP COLUMN selection_ref;
