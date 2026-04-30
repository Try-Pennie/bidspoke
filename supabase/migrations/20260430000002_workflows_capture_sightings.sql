-- Add capture_sightings flag to workflows.
-- Default true: every workflow captures sightings. Flip false on a workflow
-- to exclude it from the lead_sightings + lead_sighting_bids + persons writes.

ALTER TABLE workflows
  ADD COLUMN capture_sightings BOOLEAN NOT NULL DEFAULT true;
