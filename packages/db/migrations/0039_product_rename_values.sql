-- Product rename to Hullwise (2026-10-02, docs/DECISIONS.md): values stored with the old product name.
-- Data only and idempotent; no column is renamed or dropped.
UPDATE "discounts" SET "source" = 'hullwise' WHERE "source" = 'keel';
