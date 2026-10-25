#!/usr/bin/env bash
#
# Print the sha256 of a file, or of standard input when no file is named (#2768).
#
# CI runs on GitHub's Ubuntu runners or on the Mac runners, chosen by the org
# variable PENNIE_CI_RUNNER. Ubuntu has GNU `sha256sum`; a Mac runner may not have
# it on its PATH but always has `shasum -a 256`. Both print the hash first, so
# either gives the same answer.
#
# EXITS NON-ZERO AND PRINTS NOTHING when it cannot hash: an empty hash is what the
# artifact gate reads as "no comparison happened", which deploys, whereas a hash
# of nothing would match the other side's and skip.

set -uo pipefail

if [ "$#" -gt 0 ] && [ ! -r "$1" ]; then
  printf 'sha256: cannot read %s\n' "$1" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  OUT=$(sha256sum "$@") || exit 1
elif command -v shasum >/dev/null 2>&1; then
  OUT=$(shasum -a 256 "$@") || exit 1
else
  printf 'sha256: neither sha256sum nor shasum is on the PATH\n' >&2
  exit 1
fi

read -r HASH _ <<<"$OUT"
if [ -z "${HASH:-}" ]; then
  printf 'sha256: hashing produced nothing\n' >&2
  exit 1
fi
printf '%s\n' "$HASH"
