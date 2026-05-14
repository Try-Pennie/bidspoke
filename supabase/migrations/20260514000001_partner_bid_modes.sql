-- Partner bid modes — decouples API-call semantics from bid-source semantics.
--
-- Two new fields, plus one extraction config + one probe scratchpad:
--
--   bid_mode               'commit'   — partner API call creates a lead / commits state
--                          'ping_only' — partner API call is a lightweight bid quote, no side effects
--
--   bid_comparison_source  'auto'     — use whatever bid_resolver_type produces (today's behavior)
--                          'api'      — extract comparison bid from the API response (extractBid)
--                          'formula'  — evaluate bid_resolver_config.formula AFTER the API call
--                                       for comparison; use the API only for eligibility + extras
--                          'matrix'   — reserved for future hybrid (call API, look up matrix bid)
--
--   extra_extraction       JSONB: {<output_key>: <dot.path> | {classifier: <name>}}
--                          Pulls partner-specific bits out of the API response into output.extra
--                          (e.g. AmOne clickUrl, Tripoint leadId + result classification).
--                          Dot paths are evaluated against the response body. Classifiers are
--                          named functions registered in code (e.g. 'tripoint_result').
--
--   last_probe_response    JSONB scratchpad written by the Probe button on partner settings.
--                          Seeds the schema-aware dropdown in the extra_extraction editor.

ALTER TABLE partner_configs
  ADD COLUMN bid_mode TEXT NOT NULL DEFAULT 'commit'
    CHECK (bid_mode IN ('commit', 'ping_only')),
  ADD COLUMN bid_comparison_source TEXT NOT NULL DEFAULT 'auto'
    CHECK (bid_comparison_source IN ('auto', 'api', 'formula', 'matrix')),
  ADD COLUMN extra_extraction JSONB,
  ADD COLUMN last_probe_response JSONB;
