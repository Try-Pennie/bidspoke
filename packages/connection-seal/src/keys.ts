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
 * Only ever a PUBLIC key. The private half lives in the ops Worker secret
 * OPS_CONNECTIONS_PRIVATE_KEY and in the file ops-connections-private.pem
 * attached to the 1Password item "Bidspoke recovery keys", never here; keys.test.ts scans every file in this package for it.
 */
export const OPS_CONNECTION_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  // Generated 2026-10-17 (RSA 4096); the private half is escrowed in
  // "Bidspoke recovery keys", as the attached file ops-connections-private.pem.
  'ops-2026-10': `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAtDKUKwtVlTjzSR0g5xyc
gsbQEDz3kfObQ8oyjHdvdiTANpReD1NniLThyj6JPLrYKvjHaB3Xgyo8z3njzdhX
exAUcLkMusDyBjxLGZjhV0yO/zZHHTQayxabiw3RC2Xpy2oL/PD3UN/Gdd7C7MGu
5xU67L44oUJ0pxX4A7K4kb/E91fXgZs3xxQlPLbJ7Bk5ON0elqBhti0NvgPeiOuN
kLSokALR1qM6wYrHV/tz90Hcfbw/hmsHlpO04HF/n7+sxGzKmT86g73f1+eSBKuk
82aTNIe8jrewa9lInrdbjmToPrCnnPgDVcguylFD6YgtBU32Mh9qbUIf7d6Zc3oV
wqMQtXO+xS9P/LEkag5RdnyGCXjPAg1874wwexD/9zFUUw/8NxizHGVw0WdTIbSQ
k8d83WBVtu13J+Ue4B6FxHxPUKth7b4nRJd8q/5Lu7D7zSwrSborQAabZUi5aDr4
b15JW7nuqo0sJlGHlm9QVaIvl/cvRG2WGsWJ6oTVB8RIKexbiBhZcijygdys+DJx
J836xg7B2b9OhrCqUDXg3SqExIMYrTMIl38psDHctESEjeGg8BQPb+7pUmM3bH6U
DKGxIBc2ParQfXu1/SxXeyZKbzgNVHswExwdSlAL0JCC7vtoFPzhva1cifaHnFyP
zqLtlQU3TW5WZhiq7xUu1q0CAwEAAQ==
-----END PUBLIC KEY-----
`,
  // Generated 2026-10-19 (RSA 4096) for the practice rotation of #2333; the
  // private half is escrowed in "Bidspoke recovery keys", as the attached file
  // ops-connections-private-next.pem.
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
