#!/usr/bin/env bash
# Daily digest of problem reports, sent from the box so the address is never on
# the site.
#
# Two ways, both keep the destination off the public page:
#
#   1. ntfy.sh (recommended, no email address involved at all)
#        topic=$(openssl rand -hex 16)
#        printf 'MDOWN_NTFY_URL=https://ntfy.sh/%s\n' "$topic" > /etc/mdown/notify.env
#        chmod 600 /etc/mdown/notify.env
#        # subscribe to the topic in the ntfy app; the box only ever knows the topic
#
#   2. email through a relay you already have (SMTP creds in the same file)
#        MDOWN_SMTP_URL=smtps://USER:PASS@smtp.example.com:465
#        MDOWN_MAIL_TO=you@example.com
#
# Cron, 09:00 UTC:
#   0 9 * * * /opt/mdown/report-digest.sh >/dev/null 2>&1
set -euo pipefail

INBOX="${MDOWN_REPORT_DIR:-/var/lib/mdown/jobs/reports}"
STATE="/var/lib/mdown/jobs/.digest-stamp"
CONF="/etc/mdown/notify.env"

[ -f "$CONF" ] && . "$CONF"

yesterday=$(date -u -d 'yesterday' +%Y-%m-%d 2>/dev/null || date -u -v-1d +%Y-%m-%d)
file="$INBOX/$yesterday.jsonl"
[ -f "$file" ] || exit 0

count=$(wc -l < "$file" | tr -d ' ')
[ "$count" = "0" ] && exit 0

body=$(python3 - "$file" "$yesterday" <<'PY'
import json, sys
path, day = sys.argv[1], sys.argv[2]
rows = []
for line in open(path, encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    try:
        row = json.loads(line)
    except ValueError:
        continue
    rows.append("- %s · %s · %s" % (row.get("page", "?"), row.get("state", "?"), (row.get("note") or "")[:180]))
print("mdown reports for %s: %d\n" % (day, len(rows)))
print("\n".join(rows[:40]))
PY
)

if [ -n "${MDOWN_NTFY_URL:-}" ]; then
  printf '%s' "$body" | curl -fsS -m 20 -H "Title: mdown reports $yesterday" --data-binary @- "$MDOWN_NTFY_URL" >/dev/null
fi

if [ -n "${MDOWN_SMTP_URL:-}" ] && [ -n "${MDOWN_MAIL_TO:-}" ]; then
  printf 'To: %s\nSubject: mdown reports %s (%s)\nContent-Type: text/plain; charset=utf-8\n\n%s\n' \
    "$MDOWN_MAIL_TO" "$yesterday" "$count" "$body" |
    curl -fsS -m 30 --url "$MDOWN_SMTP_URL" --mail-from "${MDOWN_MAIL_FROM:-mdown@localhost}" \
      --mail-rcpt "$MDOWN_MAIL_TO" --upload-file - >/dev/null
fi

date -u +%FT%TZ > "$STATE" 2>/dev/null || true
