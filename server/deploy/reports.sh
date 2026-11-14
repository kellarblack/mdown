#!/usr/bin/env bash
# Read the private report inbox from the box.
#
#   ./server/deploy/reports.sh 136.0.57.157
#   ./server/deploy/reports.sh 136.0.57.157 100     # last 100
#
# Reports are one JSON object per line, stored under the API's work dir:
#   /var/lib/mdown/jobs/reports/YYYY-MM-DD.jsonl
set -euo pipefail

HOST="${1:-}"
LIMIT="${2:-40}"
KEY="${MDOWN_KEY:-$HOME/.ssh/mdown_oracle}"

if [ -z "$HOST" ]; then
  echo "usage: $0 <host> [limit]" >&2
  exit 2
fi

ssh -i "$KEY" -o BatchMode=yes "root@$HOST" \
  "tail -n $LIMIT /var/lib/mdown/jobs/reports/*.jsonl 2>/dev/null || true" |
python3 -c '
import json, sys, time
rows = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        rows.append(json.loads(line))
    except ValueError:
        continue
for row in rows:
    when = time.strftime("%d %b %H:%M", time.gmtime(row.get("t", 0)))
    print("%s  %-14s  %-5s  %s" % (when, (row.get("page") or "")[:14], row.get("state") or "-", row.get("note") or "(no note)"))
    ua = row.get("ua") or ""
    if ua:
        print("                  %s" % ua[:90])
if not rows:
    print("no reports yet")
'
