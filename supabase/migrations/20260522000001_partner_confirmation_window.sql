-- Latency Gate — per-partner bid→confirmation latency threshold.
--
-- confirmation_window_ms: operator-set maximum acceptable latency (ms) between our
-- Bid and the partner's Bid Win Confirmation post. The Latency Gate "check" node
-- compares measured latency against this value; when latency exceeds it, the
-- confirmation is rejected (BW Pennie Response = reject due to latency).
-- NULL = no per-partner threshold configured; the Latency Gate node must then carry
-- a node-level threshold_ms override.

ALTER TABLE partner_configs
  ADD COLUMN confirmation_window_ms INTEGER;
