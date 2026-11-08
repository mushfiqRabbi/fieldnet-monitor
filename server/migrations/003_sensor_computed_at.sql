-- The time a sensor was last replayed up to. A replay never goes back before it.
ALTER TABLE sensors ADD COLUMN computed_at timestamptz;
