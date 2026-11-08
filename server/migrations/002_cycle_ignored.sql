-- Remember which sensors a cycle report was ignored for, so an identical repeat
-- can answer with the same list.
ALTER TABLE cycles ADD COLUMN ignored text[] NOT NULL DEFAULT '{}';
