/**
 * The ops public keys that seal ops connection logins, by kid (#2333).
 *
 * A code constant on purpose: its integrity comes from review. A public key
 * fetched from ops at seal time could be swapped by whoever controls that
 * fetch, and every login sealed afterwards would open for them instead.
 *
 * The SPKI PEM that `openssl pkey -pubout` writes goes here under its kid, and
 * CURRENT_OPS_KID names the one new seals use. Rotation adds the NEXT kid
 * beside it in a normal deploy, then moves CURRENT_OPS_KID to it so the reseal
 * can move every envelope there, and removes the old kid once none names it
 * (docs/disaster-recovery.md, rotating the ops private key).
 *
 * A new kid must not be a prefix of any registered kid, nor have one as its
 * prefix: name it by the full date it was generated, `ops-YYYY-MM-DD`. With
 * ops-2026-10 and ops-2026-10-19 both registered, a test matching a message by
 * the shorter kid passed against the longer one (#2509); keys.test.ts refuses
 * such a pair.
 *
 * Only ever a PUBLIC key. The private half lives in the ops Worker secret
 * OPS_CONNECTIONS_PRIVATE_KEY and in the file ops-connections-private.pem
 * attached to the 1Password item "Bidspoke recovery keys", never here; keys.test.ts scans every file in this package for it.
 */
export const OPS_CONNECTION_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  // Generated 2026-10-19 (RSA 4096) for the practice rotation of #2333, and
  // the only kid since its step 4 (2026-10-19) removed ops-2026-10. The
  // private half is OPS_CONNECTIONS_PRIVATE_KEY on the ops Worker, escrowed in
  // "Bidspoke recovery keys" as the attached file ops-connections-private.pem.
  // The retired ops-2026-10 key is kept there as
  // ops-connections-private-retired-ops-2026-10.pem until no envelope anywhere
  // names its kid (none did when it was removed).
  'ops-2026-10-19': `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAp+ve1H5AHhQVLxqqZhbN
yKr9Vt7lsMOppFTOJtnFJ1FbgWnXvuvQz6c7l3Kd0S7Y+x/MSq0uMt4H451vNKrS
PUlWUbpjMAUJEczG82O5tgfPG9PbFhIOymxCab1oit5YUjzZzYPZf21jC3l4u5B0
zbyfJanvtw3i5K93uWbjr2fJ2pPW94waOs9vQz5Snm/P1bz3zR6WbzU64qETgHXF
gCagLSPkG7RithoqdmTuKqZxSmubAqIoZu1zbtnwoJkEGVgJP0HQBfUcgCgtlXWt
KCinUeGWESYPRtouq+51FAs/2ACZF7RARQPQyUyd+22sWodWmNEPR9SIiIPlDRNm
OqRBK2ENOZCN13kXLv/5peA16YVNMS3qGFFTO6XjYPTLoADeUBxeSreUtfSi3AMO
k6e8JCytom3FUu67LyxXta2I++qo/u/MV1G3MIz2HAcN8/FMSaRSK0qwOTd/RVhp
/7l1m5ZyIFtjrFS1MSVOdPlpT1MHPEWk9hpTTzJ48oVN6/g16ow1LFrjJJqvsUEt
qLcVuchAheoq+RtMnSvD0YV7D1IksZv+ruAGdkO1lblMfytc2fX+WnU1klg5IahL
H617llSOkt54GWvXpWmWqBZIi8/r1NWyysI2Q2iNATt3R2HV8dF+lEy24QshCrg7
7/g8rSir1ecNJ642CXN1G20CAwEAAQ==
-----END PUBLIC KEY-----
`,
})

/** The kid new seals use. */
export const CURRENT_OPS_KID: string | null = 'ops-2026-10-19'
