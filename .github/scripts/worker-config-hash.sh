#!/usr/bin/env bash
#
# Hash the worker's DEPLOY-TIME CONFIGURATION (#1420).
#
# `dist/index.js` is not the whole of what a worker deploy changes. wrangler.toml
# carries `[vars]`, `[triggers]` crons, `[limits]` and every binding, and the
# deploy is what applies them; none of it appears in the bundle. So a gate that
# compares only the bundle is blind to all of it.
#
# Measured on 2026-09-21: #1404 set `PARTNER_PROBE_ALERTS = "on"` and changed one
# source comment. The bundle was byte identical, the artifact gate skipped, Deploy
# reported success, and an hour later the probe was still logging `mode=observe`.
# The change had merged and was not live.
#
# Prints a sha256 of the file with comment-only lines and blank lines removed, so
# every setting moves the hash and prose does not. Prose is excluded because the
# thing this gate avoids is a needless redeploy of the live bidding engine, and
# wrangler.toml is heavily commented on purpose.
#
# EXITS NON-ZERO AND PRINTS NOTHING when the file cannot be read, rather than
# printing a hash of nothing. An empty hash is what the decision script treats as
# "no comparison happened", which makes it deploy; a hash of nothing would match
# the other side's hash of nothing and skip (L42, L215).

set -uo pipefail

CONFIG="${1:-apps/worker/wrangler.toml}"

if [ ! -r "$CONFIG" ]; then
  printf 'worker-config-hash: cannot read %s\n' "$CONFIG" >&2
  exit 1
fi

# Drop whole-line comments and blank lines, keep every other byte verbatim. An
# end-of-line comment is deliberately KEPT rather than parsed off: telling a
# comment from a `#` inside a quoted value needs a TOML parser, and counting one
# is the harmless direction here.
HASH=$(sed -e 's/^[[:space:]]*#.*$//' "$CONFIG" | grep -v '^[[:space:]]*$' | sha256sum | cut -d' ' -f1)

if [ -z "$HASH" ]; then
  printf 'worker-config-hash: hashing %s produced nothing\n' "$CONFIG" >&2
  exit 1
fi

printf '%s\n' "$HASH"
