-- New workflows start switched off (#1706).
--
-- The create and duplicate routes write is_active false themselves. This makes
-- the column default agree, so a writer that omits the field (a future importer,
-- a script, a hand written INSERT) also gets a workflow that takes no traffic
-- until a person switches it on (L72: the stored default is the safe value).
--
-- Expand only (ADR 0007): changing a column default touches no existing row and
-- no reader. Every live workflow keeps the is_active value it has now. Code that
-- still writes is_active true explicitly keeps working against this schema, and
-- the new code writes false explicitly, so it does not depend on this default:
-- the apply and the deploy can happen in either order.

ALTER TABLE public.workflows ALTER COLUMN is_active SET DEFAULT false;
