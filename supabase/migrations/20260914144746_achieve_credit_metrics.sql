-- The credit figures behind Achieve's decline reasons, recorded per send.
--
-- Achieve return no reason on a decline: every "didn't qualify" response is the same five
-- fields, while their duplicate responses do carry a response_details array. The reason
-- statements they sent by hand on 2026-09-14 are all credit file factors (inquiries, balance
-- to limit, derogatory records, time since newest account, installment paydown), and every
-- one is computable from the Equifax report we already pull and previously discarded.
--
-- Recording them per send is what makes the accepted and declined populations comparable.
-- Without it the only durable columns are the score, income, loan amount and debt, because
-- the report itself lives in execution logs that roll off after seven days.
--
-- Expand only: nullable with no default, so code and schema deploy in either order. Rows
-- written before this keep NULL, which is honest. ALTER on the partitioned parent propagates.
ALTER TABLE public.achieve_evaluations
  ADD COLUMN IF NOT EXISTS credit_metrics jsonb;

COMMENT ON COLUMN public.achieve_evaluations.credit_metrics IS
  'Credit figures derived from the Equifax report at send time: revolving utilisation, account ages, inquiry counts, collections, bankruptcies, installment paydown, delinquency recency and the score. Null where no report could be read. Exists so accepted and declined leads can be compared against what Achieve underwriting reacts to, since their decline responses carry no reason.';
