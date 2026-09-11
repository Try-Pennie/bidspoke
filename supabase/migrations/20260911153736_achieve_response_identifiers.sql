-- Capture the two identifiers Achieve's edge stamps on every response.
--
-- Their decline responses carry nothing beyond one sentence ("Lead N didn't qualify for
-- offers"), with no reason code and no detail field, though their duplicate responses do
-- carry a response_details array. So the only way to have their support look up a specific
-- call is to quote an identifier they issued, rather than describing the lead by timestamp
-- and partner reference.
--
--   achieve_request_id  their own application request id (x-request-id)
--   cf_ray              the Cloudflare ray from the proxy in front of their API, which is
--                       the identifier that matters for edge questions such as #1265
--
-- Both measured present on an unauthenticated call (2026-09-11), so they do not depend on
-- the request being accepted, which is what makes them useful on a failure.
--
-- Expand only: nullable with no default, so code and schema can deploy in either order.
-- Every row written before this exists keeps NULL, which is honest: nothing captured them.
-- ALTER on the partitioned parent propagates to all 7 partitions.
ALTER TABLE public.achieve_evaluations
  ADD COLUMN IF NOT EXISTS achieve_request_id text,
  ADD COLUMN IF NOT EXISTS cf_ray text;

COMMENT ON COLUMN public.achieve_evaluations.achieve_request_id IS
  'Achieve x-request-id response header. Quote this to their support to identify a call.';
COMMENT ON COLUMN public.achieve_evaluations.cf_ray IS
  'Cloudflare cf-ray from the proxy in front of Achieve''s API.';
