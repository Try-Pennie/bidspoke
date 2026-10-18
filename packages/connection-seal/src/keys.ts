/**
 * The ops public keys that seal ops connection logins, by kid (#2333).
 *
 * A code constant on purpose: its integrity comes from review. A public key
 * fetched from ops at seal time could be swapped by whoever controls that
 * fetch, and every login sealed afterwards would open for them instead.
 *
 * The SPKI PEM that `openssl pkey -pubout` writes goes here under its kid, and
 * CURRENT_OPS_KID names the one new seals use. Rotation adds the NEXT kid
 * beside it in a normal deploy, and moves CURRENT_OPS_KID once every envelope
 * is resealed.
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
})

/** The kid new seals use. */
export const CURRENT_OPS_KID: string | null = 'ops-2026-10'
