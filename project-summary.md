# Bidspoke — Project Summary

**Purpose:** Build a custom lead routing and bidding engine that replaces our current Pipedream workflows with a visual tool designed specifically for how Pennie evaluates, bids on, and routes leads to partners.

---

## The Problem

Today, when a lead comes in from our website (or Wallet Owl, Reserve, etc.), it flows through a Pipedream workflow that validates the lead, pulls credit, enriches it with debt data, and then decides where to send it — Tripoint, M1, Engine, or back to Pennie.

This works with 2 direct partners. But it has real limitations:

- **Sequential execution** — each partner check happens one after another. Add a third, fourth, fifth partner and the wait time stacks up. In the worst case (like EPC's funnel), someone could wait 2 minutes.
- **No simultaneous bidding** — we can't ask all partners for bids at once and pick the highest. We're stuck in a waterfall.
- **No per-partner controls** — we can't easily set rules like "limit M1 to 250 leads/day" or "exclude all M1 bids under $X" without ugly workarounds.
- **Dedup is costing money** — Tripoint has been billing back duplicates because we weren't doing dedup checks. They now have an API for it, but wiring that in adds another sequential step.
- **Scaling partners breaks the model** — if we move into the payday space with 10–20 partners, the current approach falls apart.
- **Dependency on Bruno** — the current Pipedream setup depends on one person, which is risky as this becomes more central to the business.

---

## What We're Building

Bidspoke — a visual tool where team members — including non-technical staff — can build, edit, test, and run lead routing workflows. The core experience:

### Two Modes: Outbound Routing & Inbound Bidding

Bidspoke handles both sides of the lead marketplace:

**Outbound routing** — Pennie's own leads (from the website form, Wallet Owl, Reserve, etc.) come in, get validated and enriched (credit pull, debt calculation), and then get routed to the highest-bidding partner. This is the hub-and-spoke model with parallel partner bids.

**Inbound bidding** — External networks (like Engine) ping Pennie with a lead and ask for a bid. Pennie evaluates the lead (lighter validation, no credit pull), runs it through a decision engine (like LendSwift), and responds with a structured offer (name, rate, click URL, logo) or a rejection. This is the ping-post pattern.

Both modes share the same building blocks — validation, branching, API calls, Salesforce record creation, response formatting — just assembled differently. Bidspoke makes it easy to build either type of workflow from the same set of components.

### Hub-and-Spoke Bidding (Outbound)

The central feature for outbound flows. When a lead comes in:

1. **Validate and enrich** — pull credit (Equifax, with Eligibility Scout as fallback), calculate debt, determine if it's a Pennie fit
2. **Solicit bids simultaneously** — hit all eligible partners at once, not one at a time
3. **Pick the winner** — route to the highest bidder based on configurable logic
4. **Engine as fallback** — anything that doesn't get picked up flows to Engine as the final repository

This replaces the sequential waterfall with a parallel model that doesn't slow down as you add partners.

### Bid Response (Inbound)

For inbound flows, the workflow receives a lead via webhook, evaluates it against eligibility criteria (state, loan amount, name validity, military status, etc.), pings a decision engine for a bid, applies margin math (e.g., bid × multiplier), and responds with a structured offer or rejection. Salesforce dedup is built into the flow — if the applicant already exists, the lead is rejected automatically.

### Partner Controls

Per-partner rules that business and ops people can configure visually:

- Daily caps (e.g., "max 250 leads/day to M1")
- Minimum bid thresholds (e.g., "exclude M1 bids under $X")
- Dedup checking against partner APIs
- Enable/disable partners without touching code
- Bid value formulas (e.g., Tripoint's value = constant × debt amount)

### Visual Workflow Builder

- Drag-and-drop canvas for building and editing the full flow
- Configurable branching logic (if/else with AND/OR rule groups)
- Support for parallel paths (the hub-and-spoke model)
- Inline code editor for steps that need custom logic (engineers), with visual configuration for everything else (ops team)
- Each step can have its own variables; workflows have a config panel; environment variables span across all workflows
- Ability to reference data from any previous step

### Multiple Sources, Same Logic

The evaluation and routing logic is the same regardless of where the lead comes from — website form, Wallet Owl, Reserve, Engine, etc. Bidspoke makes it easy to reuse the same pipeline across different sources, not force you to rebuild it each time.

### Import from Pipedream

Paste the JSON export from an existing Pipedream workflow and automatically reconstruct it on the canvas. We have fewer than 10 workflows to migrate.

### Integrations (Schema-Aware)

Bidspoke knows about our external systems and offers dropdowns, field names, and autocomplete — not just raw API calls:

- **Salesforce** — objects, fields, record types
- **Supabase** — tables and columns
- **Snowflake** — schemas and tables (also used for data storage)
- **Equifax API** — credit report pulls
- **Eligibility Scout** — credit report fallback
- **LendSwift / Taktile** — decision engine for inbound bid evaluation
- **Partner APIs** — Tripoint, M1, Engine, and future partners

### Execution & Performance

- **Runs the workflows directly** — not just a design tool, it executes in real time when triggered via HTTP webhook
- **Handles high-volume, all-day traffic with bursts** — this is a heavy-use system, can't be overstated
- **Parallel execution** is the whole point — simultaneous partner bids without sequential delays

### Testing & Debugging

- Feed a sample payload into a workflow and watch it execute step by step
- Friendly enough for non-technical users to run tests
- When a flow fails: see which step failed, view the error, and either replay from the beginning or step through from the failure point with the original payload
- **Automatic Slack alerts on failure**

### Versioning & History

- Every save creates an internal version snapshot — browse past versions, preview, and restore with one click
- Also backed by GitHub for diffs, backup, and developer-level tooling

### Storage

- Supabase for app data (workflow definitions, users, version history, execution logs)

---

## Who Uses It

At least 3 people — a mix of engineers and business/ops staff. Some will only interact with the visual layer (configuring partner rules, setting caps, toggling partners), while engineers can write code in step editors when needed.

---

## Where This Is Headed

This isn't urgent — the current setup works fine with Tripoint and M1. But:

- In the payday space, Geoff envisions 10–20 direct partners. That's where the sequential model breaks.
- The goal is to have this ready before scaling, not scramble after.
- Long-term, with broad network coverage across major providers, this becomes the core of an internal ping-post network — leads come in, get evaluated, and get routed to the best buyer automatically.
- The focus is on growth through infrastructure and efficiency, not headcount.

---

## What This Summary Doesn't Cover

This is a "are we on the same page" document. The full PRD covers architecture, data model, node types, Pipedream import mapping, Slack integration, security, and phasing.
