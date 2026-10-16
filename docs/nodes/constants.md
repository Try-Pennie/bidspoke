# Constants node

Exposes a set of fixed, named values to the rest of the workflow, merged with partner data pulled from the database. Use it to define workflow-level configuration in one place and reference it downstream as `steps.<constants_node_id>.output.<key>`.

## Purpose

The Constants node emits a single output object that downstream nodes read like any other step output, for example `steps.constants.output.<key>` (by convention the node is given the id `constants`, so references read `steps.constants.output.<key>`). There is no top-level `constants.` reference namespace. See [data references](../concepts/data-references.md). It combines two sources:

1. Workflow constants you define in the node's key/value editor (`config.data`).
2. Partner data loaded from the database for your organization (UUID map, sell-off offer copy, click URLs, per-partner active-bidding flags, and per-sub-account minimum bids).

The partner data is read through a cached loader (a short in-memory cache in front of a 30-day KV cache, busted automatically whenever partner or UUID config changes), so the node stays off the cold database path under load.

This node is typically the first step in a workflow so every later node can reference shared values. See [data references](../concepts/data-references.md).

## Config schema

`node.config`:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `data` | object | No | `{}` | Workflow constants as a flat key/value map. In the UI this is the "Workflow constants" key/value editor (Add key, with a value type per row). Keys must be unique. |

Standard node-config fields (`timeout_ms`, `retries`, etc.) also apply but are rarely needed here. See [workflow definition schema](../concepts/workflow-definition-schema.md).

The partner-data portion of the output is not configured on the node. It is derived from your organization's partner records. To change a click URL, sell-off copy, a partner's active flag, or a sub-account minimum bid, edit the partner on the Partners settings page; the cache is invalidated on save.

## Output shape

The output object is the merge of your `config.data` and the derived partner fields:

| Key | Source | Type | Description |
|-----|--------|------|-------------|
| (your keys) | `config.data` | any | Each constant you defined, verbatim. |
| `subAccountIdsMap` | partner data | object | Map of sub-account UUID to partner slug. |
| `activeBidding` | partner data | object | Map of partner slug to boolean. A missing slug means inactive. |
| `<Slug>SellOffOfferTitle` | partner data | string | Sell-off offer title for the partner, slug capitalized. Present only if set. |
| `<Slug>SellOffOfferDetails` | partner data | string | Sell-off offer details, slug capitalized. Present only if set. |
| `<Slug>ClickUrl` | partner data | string | Click URL for the partner, slug capitalized. Present only if set. |
| `<Slug>SubAccountMinBids` | partner data | object | Map of sub-account UUID to minimum bid (numbers greater than 0). Present only if the partner has floors set. |

The `<Slug>` prefix is the partner slug with its first letter capitalized. For example a partner with slug `sofi` and a click URL produces `SofiClickUrl`. The names are built in one place, `partnerConstantName` in `apps/worker/src/engine/nodes/constants.ts`, and `partnerConstantOutputKeys` lists every partner key a run emits (the step log records that list as `partner_constants_keys`).

A key of your own with the same name as a partner key is replaced by the partner value, because the partner fields are merged after `config.data`. The workflow values route below reports such a key as `shadowed_data_keys`.

**Which workflows read a partner's values.** `GET /api/partners/:id/workflow-values` (#2142) answers it for one partner, from the scanner in `apps/worker/src/lib/partner-workflow-values.ts`, which the partner delete check (#2140, `GET /api/partners/:id/delete-check`) calls as well. It counts a read only as an access to this node's output (`steps.constants.output.<key>`, a local name a script assigns that output to, such as `const constants = steps.constants.output`, or a destructure from it), never the bare word. A literal entry of `activeBidding` or `subAccountIdsMap` is a read of that one partner's entry; a computed one (`activeBidding[sourceName]`) reads the value for every partner.

Downstream, read these as `steps.constants.output.SofiClickUrl`, `steps.constants.output.activeBidding.sofi`, or in a template `{{ steps.constants.output.MIN_CREDIT_SCORE }}`. There is no `constants.` shorthand: references always go through the node's step output, like every other node.

## Edges

The Constants node has a single outgoing edge and always continues to the next node. It performs no routing.

## Example

A Constants node defining workflow-level configuration. The partner fields are added automatically at run time and are not part of the config.

```json
{
  "id": "n_constants",
  "namespace": "constants",
  "type": "constants",
  "label": "Constants",
  "config": {
    "data": {
      "MIN_CREDIT_SCORE": 640,
      "MAX_LOAN_AMOUNT": 50000,
      "BRAND_NAME": "Reserve My Loan",
      "EXCLUDED_STATES": ["NV", "WV"]
    }
  }
}
```

At run time this node's output would be, for example:

```json
{
  "MIN_CREDIT_SCORE": 640,
  "MAX_LOAN_AMOUNT": 50000,
  "BRAND_NAME": "Reserve My Loan",
  "EXCLUDED_STATES": ["NV", "WV"],
  "subAccountIdsMap": { "a1b2-...": "sofi", "c3d4-...": "m1" },
  "activeBidding": { "sofi": true, "m1": false },
  "SofiClickUrl": "https://sofi.example/click",
  "SofiSubAccountMinBids": { "a1b2-...": 18 }
}
```

A downstream Code node reads it as:

```js
const minScore = steps.constants.output.MIN_CREDIT_SCORE
const sofiActive = steps.constants.output.activeBidding.sofi
```

## See also

- [Code node](./code.md)
- [Data references](../concepts/data-references.md)
- [Workflow definition schema](../concepts/workflow-definition-schema.md)
