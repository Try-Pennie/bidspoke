#!/usr/bin/env bash
#
# Make sure the compare dispatch namespace exists, and its outbound Worker,
# before the engine that binds them deploys (#1708 part B).
#
# Usage: ensure-compare-namespace.sh <account_id> <namespace> <outbound_worker>
#
# Shadow runs dispatch their code to <namespace>, and the platform routes every
# request a script there makes to <outbound_worker>, which refuses it. wrangler
# refuses to deploy a Worker bound to a namespace that does not exist, and a
# namespace whose outbound Worker is missing would have nowhere to send those
# requests, so both are checked here first:
#
#   - the outbound Worker must exist, or this refuses by name (it is deployed by
#     the Deploy Compare Outbound leg, from apps/compare-outbound);
#   - the namespace is created when it is missing, so a deploy into a fresh
#     account provisions it, and the one-time creation lives in git (L31, L570).
#
# The Cloudflare API is called through CF_API when it is set, `<METHOD> <PATH>
# [json body]` with PATH under /accounts/<account_id>, printing the response
# body; otherwise through curl with CLOUDFLARE_API_TOKEN. Every outcome but
# "exists" or "created" exits 1 with an ::error:: line naming what failed.

set -uo pipefail

ACCOUNT="${1-}"
NAMESPACE="${2-}"
OUTBOUND="${3-}"

fail() {
  echo "::error::ensure-compare-namespace: $1" >&2
  exit 1
}

[ -n "$ACCOUNT" ] && [ -n "$NAMESPACE" ] && [ -n "$OUTBOUND" ] \
  || fail "usage: ensure-compare-namespace.sh <account_id> <namespace> <outbound_worker>"
command -v jq >/dev/null 2>&1 || fail "jq is not installed, so no Cloudflare answer can be read"

cf() {
  if [ -n "${CF_API:-}" ]; then
    "$CF_API" "$@"
    return
  fi
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "CLOUDFLARE_API_TOKEN is unset, so Cloudflare cannot be asked"
  local args=(-sS --max-time 30 -X "$1" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H 'Content-Type: application/json')
  [ -n "${3-}" ] && args+=(--data "$3")
  curl "${args[@]}" "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}$2"
}

# What Cloudflare said went wrong, from its answer, for the error line.
reason() {
  printf '%s' "$1" | jq -r '[.errors[]?.message] | join("; ") | if . == "" then "no reason given" else . end' 2>/dev/null || echo "an answer that is not JSON"
}

ANSWER=$(cf GET "/workers/scripts/${OUTBOUND}/settings")
printf '%s' "$ANSWER" | jq -e '.success == true' >/dev/null 2>&1 \
  || fail "the outbound Worker ${OUTBOUND} does not exist or cannot be read ($(reason "$ANSWER")), so ${NAMESPACE} would route shadow runs' requests nowhere. Deploy it first: Deploy Compare Outbound, from apps/compare-outbound."

LIST=$(cf GET "/workers/dispatch/namespaces")
printf '%s' "$LIST" | jq -e '.success == true' >/dev/null 2>&1 \
  || fail "the dispatch namespaces could not be listed ($(reason "$LIST")), so whether ${NAMESPACE} exists is unknown and none was created"

if printf '%s' "$LIST" | jq -e --arg n "$NAMESPACE" 'any(.result[]?; .namespace_name == $n)' >/dev/null 2>&1; then
  echo "ensure-compare-namespace: ${NAMESPACE} exists, with ${OUTBOUND} deployed"
  exit 0
fi

CREATED=$(cf POST "/workers/dispatch/namespaces" "{\"name\":\"${NAMESPACE}\"}")
printf '%s' "$CREATED" | jq -e '.success == true' >/dev/null 2>&1 \
  || fail "${NAMESPACE} is missing and could not be created ($(reason "$CREATED"))"
echo "ensure-compare-namespace: created ${NAMESPACE}, with ${OUTBOUND} deployed"
