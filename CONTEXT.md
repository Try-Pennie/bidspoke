# Bidspoke

A workflow automation platform for Pennie's partner bid management. Operators build workflows on a canvas that route leads, pull credit, run partner bidding, and integrate with external services. Real money moves through these workflows.

## Language

### Leads and identity

**Lead**:
A unique human, identified by SSN. The durable identity that persists across repeat arrivals. This is the canonical term for the person. Counting "leads" means counting distinct people; counting arrivals means counting Sightings.
_Avoid_: Person (internal/technical name for the same thing, e.g. the `persons` table), prospect (that is Salesforce's term).

**Lead Sighting**:
A single arrival of a Lead into the platform (one trigger firing). The same Lead arriving twice is two Sightings of one Lead.
_Avoid_: Submission, hit.

**Opportunity**:
A Lead Sighting that produced a real, monetizable bid outcome. A subset of Sightings.
_Avoid_: Won lead.

**Prospect**:
Salesforce's term for the synced lead record. External-system vocabulary, not the canonical word.

### Sources and partners

**Source**:
The labeled origin of inbound traffic, identified by an API key and stamped on each execution (e.g. a website form, Wallet Owl, Reserve). The broad concept: a Source may be a bare API-key origin with no partner record at all. Lives in its own `api_sources` table, unrelated to partner records.
_Avoid_: using bare "source" to mean a source partner (see below).

**Partner**:
An external organization Pennie does business with on leads, configured in partner settings. A partner record has a `partner_type` of `source`, `buyer`, or `both`. Normally one record per company; a company that both supplies and buys leads (e.g. Engine) is a single `both` record that gets both config surfaces (bidding and sell-off/sub-accounts). `partner_type` is the record's role, distinct from the `api_sources` Source concept (see Source).

**Source partner**:
A partner whose `partner_type` is `source`: supplies leads to Pennie and receives sell-off click-throughs. Holds sell-off offer copy and the sub-account UUID map. Never bids. Always written as two words, never bare "source".

**Buyer**:
A partner whose `partner_type` is `buyer` (or `both`): bids on and buys leads. The bidding configuration (resolver, circuit breaker, caps, response classification) applies to buyers.
_Avoid_: Buyer partner is fine but redundant; "buyer" suffices.

**Both** (partner role):
A partner whose `partner_type` is `both`: plays Source and Buyer roles in one record, exposing both config surfaces. Used when one company supplies leads and also bids (e.g. Engine).

**Engine**:
An external partner/network (a proper noun, their brand). Acts as the fallback buyer in outbound bidding and, separately, supplies free leads inbound. Always means the partner, never the runtime.
_Avoid_: using "Engine" for the execution engine (see Execution engine).

### Data durability

**Observability write**:
A best-effort, loss-tolerant write made for visibility: `execution_steps`, audit detail. May be batched; an occasional dropped row is acceptable.

**Outcome record**:
A must-not-lose write that captures a real business/money result: `lead_sightings`, `lead_sighting_bids`, the planned `opportunities`. Billing, win-tracking, and repeat-lead analytics depend on these, so they require durability guarantees (retry, ideally a durable queue with a dead-letter) distinct from Observability writes.

### Bidding

**Bid**:
An amount of money exchanged for a lead: a Buyer paying Pennie, or the price Pennie returns on an inbound ping. Reserve "bid" for lead-marketplace money. A bid comes from a formula, a matrix lookup, or the partner's API.

**Offer**:
A consumer-facing loan product presented to the Lead (the human) who acts on it: sell-off click-through copy, Achieve offers, the get-offers wall. Direction is toward the consumer. Never use "offer" for a buyer's money-for-a-lead (that is a Bid).

**Bid Group**:
The canonical, first-class node that runs an auction across N partners (cascade / highest-bid / tiered) and picks a winner. One canvas node that fans out internally.
_Avoid_: Bid Evaluation node (the retired Phase 2 predecessor; no longer a node type).

**Partner Bid**:
The lower-level building block that requests a bid from a single partner. A node type used in hand-built or imported flows; not a default palette entry. Bid Group is built on top of it.

**Sell-off**:
The Offer (copy + click URL) shown when a lead is routed to a Source partner rather than sold to a Buyer.

### Triggering and nodes

**Webhook** (trigger):
The inbound HTTP entry point that *starts* a workflow (`POST /webhooks/:id`). When precision matters, say "the webhook trigger" — never bare "webhook" for the outbound node below.

**HTTP Request node**:
The node that makes an *outbound* HTTP call (credit pulls, eligibility checks, partner APIs). Canonical palette label is "HTTP Request"; underlying `type` stays `webhook`.
_Avoid_: Webhook node, Integration node, HTTP node (all retired names for this same node). _Follow-up_: palette label + docs still say "Webhook node" and need updating.

**Salesforce node**:
The dedicated specialization for structured Salesforce operations (create/update/upsert/query/apex), with OAuth and dedup handling. Prefer it over the HTTP Request node for Salesforce.

**Environment variable**:
An org-wide (or workflow-scoped) named value, secret-capable (encrypted), read as `env.<NAME>`. Holds credentials and configuration shared across workflows. The home for anything sensitive or cross-workflow.

**Constants node**:
A node that emits per-workflow fixed values (its key/value editor) merged with partner data loaded from the database (UUID map, sell-off copy, click URLs, active-bidding flags). Read as a step output `steps.constants.output.<key>` — there is no top-level `constants.` namespace, and it is not secret-bearing. Boundary: per-workflow literals and partner data go here; credentials and cross-workflow values go in Environment variables.

### Execution

**Execution engine**:
The runtime inside the Worker that runs a workflow: it walks the graph, executes each node, and writes steps. Canonical name for the runtime, chosen to never collide with the partner Engine. In code the `engine/` namespace may say "the engine" where unambiguous; in prose, say "execution engine" whenever the partner Engine is nearby.
_Avoid_: bare "engine" in prose when ambiguous.

**Execution status**:
Whether the lead was served correctly. `failed` is reserved for the caller not receiving a correct response; a served lead whose post-response writeback failed is *not* `failed`. (Distinct from `response_status`, the HTTP code the caller got, and `outcome` — `successful` if a success node was passed, else `completed`.) Note: current code still promotes post-response failures to `failed`; see ADR 0003 (pending change).

**Post-response writeback**:
An Outcome record written after the response is sent (a `continue_after_response` step), e.g. the Salesforce patch after the Offer Response. Its durability is the queue's concern (ADR 0002), not something that should taint Execution status.
