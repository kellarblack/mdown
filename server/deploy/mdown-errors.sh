#!/bin/sh
# Read the failure log without needing to remember journalctl syntax.
#
#   mdown-errors              last 40 failures, newest last
#   mdown-errors 3f9a2c1b     the one line for a ref a visitor pasted you
#   mdown-errors "" 72        the last three days
set -eu

REF="${1:-}"
HOURS="${2:-24}"

if [ -n "$REF" ]; then
  journalctl -u mdown-api --since "$HOURS hours ago" --no-pager 2>/dev/null \
    | grep -- "$REF" || echo "no failure logged under $REF in the last $HOURS hours"
  exit 0
fi

echo "failures in the last $HOURS hours (newest last)"
echo "------------------------------------------------------------"
journalctl -u mdown-api --since "$HOURS hours ago" --no-pager 2>/dev/null \
  | grep ' error ' | tail -40 | sed -E 's/^.*error ref=/ref=/'
echo "------------------------------------------------------------"
echo "paste a ref to see one:  mdown-errors <ref>"
