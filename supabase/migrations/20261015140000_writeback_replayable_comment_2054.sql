-- What `replayable` means in the failed Salesforce writeback store (#2054).
--
-- The capture used to store any failure the engine classed permanent as refused
-- and not replayable, and the column's comment said so. That included a 401 that
-- survived the fresh login and a 403, which the replay tool (#471) keeps pending
-- as faults on our side. The capture now decides by the replay tool's own rule,
-- `salesforceRejectedTheWrite`, so the comment describes that rule instead.
--
-- Expand/contract (ADR 0007): a comment only. No column, constraint or grant
-- changes, so code and schema can deploy in either order.

COMMENT ON COLUMN public.outcome_writeback_deadletters.replayable IS
  'False only when Salesforce answered the write and rejected it, judged by salesforceRejectedTheWrite (engine/nodes/salesforce.ts), the rule the replay closes a row on, so the replay leaves it rather than resend a write Salesforce will refuse again. A login refused even after a fresh one (401), a permission refusal (403), a write Salesforce never answered, and a failure the node classed transient stay true (#2054).';
