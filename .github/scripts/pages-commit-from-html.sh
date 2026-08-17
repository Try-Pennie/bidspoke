#!/usr/bin/env bash
#
# Read the build stamp out of a page the live site served (#804).
#
# Reads the HTML on stdin and prints either the 40-character commit sha the page
# was built from, or the single word `unstamped`.
#
# `unstamped` covers three different-looking things that mean the same thing to
# the caller: no stamp element at all (an older build, from before the stamp
# existed), the placeholder an unset NEXT_PUBLIC_COMMIT_SHA renders, and a value
# that is not a commit. All three mean the page cannot say what it is serving, so
# nothing downstream may treat the reading as a commit. The caller reports it as
# its own loud outcome rather than as a pass.
#
# The match is deliberately anchored on the SHAPE of the tag, not on the string
# `bidspoke-commit` appearing somewhere in the document. A whole-document
# substring search would be satisfied by a docs page describing this mechanism
# (LESSONS L135, L156) and would report a stamp on a page that carries none.
#
# Both attribute orders are handled because the renderer decides that, not us,
# and an extractor that knew only one would report every route unstamped after a
# framework upgrade with nothing else changing.

set -uo pipefail

HTML=$(cat)

# Newlines out of the way first so a tag split across lines still matches.
FLAT=${HTML//$'\n'/ }

# The tag, then the value inside it. Two steps rather than one expression so the
# `content` taken is always one from THIS tag: a single pattern spanning the
# document could pair this tag's name with a neighbouring tag's content.
TAG=$(printf '%s' "$FLAT" | grep -oE '<meta[^>]*name="bidspoke-commit"[^>]*>' | head -1)
VALUE=$(printf '%s' "$TAG" | grep -oE 'content="[^"]*"' | head -1)
VALUE=${VALUE#content=\"}
VALUE=${VALUE%\"}

# A commit, and nothing else, is a usable answer. `unknown` (the placeholder), an
# empty value and a version string all fail this on purpose.
if printf '%s' "$VALUE" | grep -qE '^[0-9a-f]{40}$'; then
  printf '%s\n' "$VALUE"
else
  printf 'unstamped\n'
fi
