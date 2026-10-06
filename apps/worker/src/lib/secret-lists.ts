/**
 * The secret lists of both Workers (#386, #1709 plan 0.E). A module with no
 * runtime imports, so the daily guard (./required-secrets) and the CI parity check
 * (.github/scripts/worker-secret-parity.mjs, which Node runs with its own type
 * stripping) read one copy.
 *
 * The money Worker must hold every secret in REQUIRED_SECRETS and
 * REQUIRED_PARTNER_SECRETS. The ops Worker may hold ONLY what OPS_ALLOWED_SECRETS
 * names: it never gets the main service key, the encryption key, the SSN pepper or
 * any partner credential, and the parity check fails on any other secret found on
 * it. An allowlist rather than a list of forbidden names, because a money only
 * secret added later would otherwise be allowed on ops by default.
 */
// No imports at all, type ones included: the web app's tests import this file
// and cannot resolve the Worker's Cloudflare types. ./required-secrets checks at
// compile time that every name here is a binding of the Worker that needs it.

/** Secrets the worker cannot run correctly without: every one must be set in prod. */
export const REQUIRED_SECRETS = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'API_KEY_MAP',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'SECRET_ENCRYPTION_KEY',
  'SSN_HASH_PEPPER',
  'SNOWFLAKE_ACCOUNT',
  'SNOWFLAKE_USER',
  'SNOWFLAKE_PRIVATE_KEY',
  'SNOWFLAKE_DATABASE',
  'SNOWFLAKE_SCHEMA',
  'SNOWFLAKE_WAREHOUSE',
  'SNOWFLAKE_ROLE',
  // Execution archive (#871). Each pair is registered in the change that first
  // READS it, never when it is merely declared: this guard alerts every org's
  // Slack daily, so a secret listed before it is set pages every morning for
  // nothing.
  //
  // The reader and eraser were held back on exactly that reasoning, and the
  // deferral then outlived its reason. Their code paths shipped on 2026-08-22
  // (the deletion gate and the settings read-back authenticate as the reader,
  // the erasure path as the eraser), both credentials were still unset in
  // production, and the only thing that noticed was a downstream job failing
  // the next morning with a message about Snowflake availability. A deferral
  // whose condition has expired is not a deferral, it is a gap (L129).
  //
  // Kept in step with the credential map by a derived test rather than by hand.
  'ARCHIVE_WRITER_USER',
  'ARCHIVE_WRITER_PRIVATE_KEY',
  'ARCHIVE_READER_USER',
  'ARCHIVE_READER_PRIVATE_KEY',
  'ARCHIVE_ERASER_USER',
  'ARCHIVE_ERASER_PRIVATE_KEY',
] as const

/**
 * Partner values that live workflows depend on but the typed `Env` doesn't cover:
 * Salesforce is read dynamically (cast off Env), and Equifax/Tripoint are consumed
 * inside code-node scripts (the sandbox), invisible to a source grep.
 *
 * This guard checks the worker's *secret bindings*, so it must only list values that
 * are genuine wrangler secrets. The Salesforce/Equifax connection details that live
 * as non-secret rows in the `environment_variables` table (SALESFORCE_INSTANCE_URL,
 * SALESFORCE_CLIENT_ID, EQUIFAX_USERNAME) are NOT worker secrets: they are owned by
 * the separate required-env-vars guard (#394). Listing them here produced a daily
 * false-positive alert (they are always absent from the binding); likewise EQ_USER /
 * EQ_PASS were never real keys (the Equifax password secret is EQUIFAX_PASSWORD).
 * Feature-gated partners (Achieve, Eligibility Scout) stay excluded to avoid false
 * alarms.
 */
export const REQUIRED_PARTNER_SECRETS = [
  'SALESFORCE_CLIENT_SECRET',
  'EQUIFAX_PASSWORD',
  'TRIPOINT_PROXY_SECRET',
  // The shared key Achieve's firewall Skip rule matches on, sent by both the Achieve
  // Offers node and the Eligibility Scout code node (see engine/nodes/achieve-identity.ts).
  // Listed here and not with the feature-gated partners above because the Scout call
  // is on the live Main Flow path: unset, that path stays blocked, and the only thing
  // that reports it is a field-presence alert four days later, naming a symptom.
  //
  // Read what this actually measures before trusting it. This guard checks the WORKER
  // BINDING, and the Achieve node reads the DB copy (`ctx.env`, loaded per org by
  // env-loader). They are two copies of one value, written together by the
  // Environment Variables page (a secret row there is stored AND pushed to the
  // binding by setCfSecret), which is why the binding is a usable proxy at all. So it
  // catches the case that actually happens, nobody ever created it, and it is blind
  // to the DB row being deleted or blanked while the binding survives, which is the
  // direction that breaks the node silently. Nothing covers that today: the
  // required-env-vars guard (#394) reads `is_secret=false` rows only and cannot see
  // this one. Tracked in #1263.
  'ACHIEVE_PARTNER_KEY',
] as const

/** Secrets the ops Worker cannot run without (#1705, #1709). */
export const OPS_REQUIRED_SECRETS = [
  // Derives each workflow's capture key and the redaction key (src/ops/index.ts).
  'PORTING_CAPTURE_MASTER',
] as const

/** Every secret the ops Worker may hold; anything else on it fails the parity check. */
export const OPS_ALLOWED_SECRETS: readonly string[] = [...OPS_REQUIRED_SECRETS]

/**
 * Whether bidspoke-worker-ops is deployed yet. Until it is, the parity check
 * reports the ops side as not measured rather than failing on a Worker that does
 * not exist; once true, a missing ops Worker fails. Set to true in the change that
 * first deploys it (#1709 part 4).
 */
export const OPS_WORKER_DEPLOYED = false
