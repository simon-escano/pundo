-- Recipe tags and per-plan size. Schema only: data reaches devices through synced mutations (change_log), never through
-- migrations, so nothing here is pulled by clients.

-- Free-form labels ("Filipino", "High-Protein") as a JSON array of strings, mirroring the synced recipe payload.
ALTER TABLE recipes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array');

-- Plan size, fixed when a cycle is created (the Worker writes it on INSERT only). Cycles created before this migration
-- were all 2 weeks x 3 dishes, which the defaults record.
ALTER TABLE cycles ADD COLUMN weeks INTEGER NOT NULL DEFAULT 2 CHECK (weeks IN (1, 2));
ALTER TABLE cycles ADD COLUMN dishes_per_week INTEGER NOT NULL DEFAULT 3 CHECK (dishes_per_week IN (2, 3));
