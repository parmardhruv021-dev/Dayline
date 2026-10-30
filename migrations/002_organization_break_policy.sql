ALTER TABLE organizations
ADD COLUMN breaks_paid INTEGER NOT NULL DEFAULT 0 CHECK (breaks_paid IN (0,1));
