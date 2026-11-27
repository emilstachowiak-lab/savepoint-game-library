CREATE TABLE collection_revision (
  key INTEGER PRIMARY KEY CHECK (key = 1),
  version INTEGER NOT NULL
);
INSERT INTO collection_revision VALUES (1, 0);

CREATE TRIGGER collection_after_insert AFTER INSERT ON games BEGIN
  UPDATE collection_revision SET version = version + 1 WHERE key = 1;
END;

CREATE TRIGGER collection_after_update AFTER UPDATE ON games BEGIN
  UPDATE collection_revision SET version = version + 1 WHERE key = 1;
END;

CREATE TRIGGER collection_after_delete AFTER DELETE ON games BEGIN
  UPDATE collection_revision SET version = version + 1 WHERE key = 1;
END;
