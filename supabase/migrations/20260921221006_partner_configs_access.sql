-- partner_configs becomes Worker only, and its policy gains the WITH CHECK it
-- never had (#1409, L18, L124).
--
-- Measured 2026-09-21: production grants anon and authenticated INSERT, SELECT,
-- UPDATE, DELETE, REFERENCES and TRIGGER on partner_configs from both owners'
-- default ACLs, and the one policy, partners_org, is FOR ALL USING
-- (organization_id = user_org_id()) with no WITH CHECK. So any signed in member
-- of the org could update this row through PostgREST with the publishable key,
-- past every check the Worker's route makes. This row now decides where each
-- sell off lead's SSN and PII is posted (api_endpoint, cf_secret_key,
-- outbound_field_mapping, is_active), which is why it is closed now.
--
-- Precondition, checked before writing this: apps/web holds no direct
-- `.from('partner_configs')` read (rg over apps/web/src on 2026-09-21 found
-- none outside tests and guards). Every read and write goes through the Worker
-- as service_role, which these revokes do not touch.
--
-- The policy is left in place and gets WITH CHECK, so if a grant to
-- authenticated is ever restored the write side is still scoped to the org.
--
-- Expand only: privileges and a policy clause; no shape changes.
REVOKE ALL ON public.partner_configs FROM PUBLIC, anon, authenticated;

ALTER POLICY "partners_org" ON public.partner_configs
  USING (organization_id = public.user_org_id())
  WITH CHECK (organization_id = public.user_org_id());
