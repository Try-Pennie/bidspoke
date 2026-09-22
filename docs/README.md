# Bidspoke Documentation

Bidspoke is a visual workflow builder for lead routing and partner bidding. You build workflows on a drag-and-drop canvas, trigger them over HTTP, and they run in real time: validating leads, pulling credit, soliciting bids from partners in parallel, picking a winner, and responding with an offer.

This documentation explains how the platform works and how to build with it. It is written for two audiences: the ops team that builds and runs workflows, and AI assistants (Claude, ChatGPT) that people ask for help building workflows. Every page is grounded in the platform's actual behavior.

## Start here

- New to Bidspoke? Read the [Overview](concepts/overview.md), then follow [Getting started](guides/getting-started.md) to build your first workflow.
- Building a bidding flow? See [Building a bidding workflow](guides/building-a-bidding-workflow.md) and the [Bidding model](concepts/bidding-model.md).
- Need an AI to build a workflow for you? Point it at [llms.txt](../llms.txt), or paste the [Workflow definition schema](concepts/workflow-definition-schema.md) and [Data references](concepts/data-references.md) pages.

## Concepts

Understand the platform.

- [Overview](concepts/overview.md) - what Bidspoke is and the two modes (outbound routing, inbound bidding).
- [Workflows and executions](concepts/workflows-and-executions.md) - the core domain model: workflows, versions, executions, steps.
- [Triggers and endpoints](concepts/triggers-and-endpoints.md) - how workflows are invoked over HTTP.
- [Data references](concepts/data-references.md) - the expression and template syntax (`steps.*`, `trigger.*`, `env.*`).
- [Workflow definition schema](concepts/workflow-definition-schema.md) - the canonical JSON shape of a workflow. The page an AI uses to build one.
- [Bidding model](concepts/bidding-model.md) - hub-and-spoke and ping-post bidding, caps, circuit breakers, dedup.
- [Lead outcome recovery](concepts/lead-outcome-recovery.md) - how lead outcomes are durably recorded and how stranded leads (lost to Worker eviction) are recovered.
- [Glossary](concepts/glossary.md) - definitions of every term used across the docs.

## Nodes

Every node type, with config schema and examples. See the [node catalog](nodes/README.md) for the full list.

Control flow: [Filter](nodes/filter.md), [Branch](nodes/branch.md), [Parallel](nodes/parallel.md), [Exit](nodes/exit.md), [Response](nodes/response.md).
Data and integrations: [Code](nodes/code.md), [Webhook](nodes/webhook.md), [Salesforce](nodes/salesforce.md), [Transform](nodes/transform.md), [Constants](nodes/constants.md), [Data Store](nodes/data-store.md).
Bidding: [Bid Group](nodes/bid-group.md), [Partner Bid](nodes/partner-bid.md), [Latency Gate](nodes/latency-gate.md), [Buyer Select](nodes/buyer-select.md).

## Guides

Task-oriented walkthroughs.

- [Getting started](guides/getting-started.md) - build, save, test, and trigger your first workflow.
- [Building a bidding workflow](guides/building-a-bidding-workflow.md) - an end-to-end outbound routing flow.
- [Configuring a partner](guides/configuring-a-partner.md) - add and configure a bidding partner.
- [Testing and debugging](guides/testing-and-debugging.md) - the Test Runner, execution overlay, replay, and resume.
- [Environment variables and secrets](guides/environment-variables-and-secrets.md) - where credentials live and how nodes read them.
- [Versioning and backup](guides/versioning-and-backup.md) - version snapshots, restore, and GitHub backup.

## Reference

Precise, lookup-oriented detail.

- [REST API](reference/api.md) - the management API (`/api/*`).
- [Webhook contract](reference/webhook-contract.md) - the exact HTTP contract for triggering workflows.
- [Partners](reference/partners.md) - every partner configuration field.
- [Error handling](reference/error-handling.md) - error classification, retries, fallback, alerts.
- [Observability](reference/observability.md) - the dashboard, tracing, alerts, cost, and retention.

## Examples

- [Annotated workflow](examples/annotated-workflow.md) - a complete workflow definition, explained node by node.

## Conventions in these docs

- Code, JSON, and field names appear in `monospace`.
- Config fields are documented in `Field | Type | Required | Default | Description` tables.
- Where the platform's behavior has changed over time, these docs describe what the platform does today, not historical plans.
