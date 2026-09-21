# Tripoint response fixtures

One file per response shape the live `tripoint_ping` step recorded, captured on
2026-09-21 from `execution_steps.output.debug` on the Engine Bidding Workflow
(`da82a183-1a4a-417e-b0b8-5f3fe5e14840`), with the redaction done inside the SQL
that read them (L222): every hex run of six or more characters became `h`, every
`id`, `leadId` and `partnerLeadId` string became `masked`, digits in the 502 body
became `9`, and anything shaped like an email became `masked@masked`. The
`partnerLeadId` values are our own Salesforce Prospect ids, masked anyway.

| File | Shape | Source window | Seen in the 7 days to 2026-09-20 |
| --- | --- | --- | --- |
| `success-1001.json` | 200, `ok: true`, resultCode 1001 | 2026-09-20 15:00 to 18:00 UTC | 13,000 plus |
| `duplicate-1002.json` | 200, `ok: true`, resultCode 1002 | same | dozens a day |
| `duplicate-1003.json` | 200, `ok: true`, resultCode 1003 | same | about 1,000 a day |
| `duplicate-1005.json` | 200, `ok: true`, resultCode 1005 | same | dozens a day |
| `in-progress-1009.json` | 200, `ok: true`, resultCode 1009, no partnerLeadId | same | a few a day |
| `invalid-502.json` | 502, `ok: false`, `details[].message` starting "Invalid" | 2026-09-19 | 3 in 7 days |

**Not observed** in the 7 day window or in the sampled 3 hours, and therefore
carrying no fixture here rather than one shaped by hand from the script: the
`Cannot return null for non-nullable field CreateLeadResponse.id` 502 fault, a
2xx with no result code, a 2xx with `ok` not true, an empty body, a 208, and any
4xx. The operator tests cover those shapes with plainly synthetic bodies that
are labelled as such; they are not Tripoint fixtures.
