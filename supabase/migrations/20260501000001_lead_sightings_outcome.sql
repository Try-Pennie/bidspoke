-- Denormalize workflow_executions.outcome onto lead_sightings.
-- Lets analytics queries say `where outcome = 'successful'` without needing
-- to know which terminal node names mean "success" for each workflow.
-- Engine populates at finalize time; values mirror workflow_executions.outcome:
--   'successful' | 'completed' | 'failed'

ALTER TABLE lead_sightings
  ADD COLUMN outcome TEXT;

CREATE INDEX lead_sightings_outcome_idx
  ON lead_sightings (outcome)
  WHERE outcome IS NOT NULL;
