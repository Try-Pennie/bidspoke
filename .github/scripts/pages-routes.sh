#!/usr/bin/env bash
#
# The public routes every site check samples, in one place (#901).
#
# Two workflows fetch these: Deploy Drift, which reads the commit stamp off each
# one every hour to tell a stranded site from a shipped one, and the Deploy Pages
# job, which watches the same routes flip to the commit it just uploaded so the
# propagation time is measured on every deploy. The grace period Deploy Drift
# allows after a deploy is set from those measurements, so the two must sample
# the same routes or the measurement calibrates a window the check never
# applies to (LESSONS L209, L41). A test derives the drift job's timeout from
# this list, so a route added here re-checks that too.
#
# Both prerendered and edge-rendered routes, all public so the auth gate does
# not redirect them to /login and leave the reader holding a redirect instead
# of a page.
#
# Sourced, not executed:  . .github/scripts/pages-routes.sh
# shellcheck disable=SC2034  # read by the two workflows that source this file
PAGES_ROUTES="/login /access-denied /dev/nodes /docs"
