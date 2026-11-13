#!/bin/sh
# Ask the API whether it is healthy; restart it if it is not.
#
# systemd restarts a process that dies, but not one that is alive and wedged:
# a stuck thread, an exhausted thread pool, or a job holding a lock forever.
# This is the check that notices.
#
# A restart storm is worse than a broken service, so a failed check only
# restarts once every 10 minutes and logs what it saw.
set -eu

URL="http://127.0.0.1:9000/health"
STAMP="/run/mdown-health.restarted"

code=$(curl -s -o /tmp/mdown-health.json -w '%{http_code}' --max-time 12 "$URL" 2>/dev/null || true)
[ -n "$code" ] || code=000

if [ "$code" = "200" ]; then
  rm -f "$STAMP"
  exit 0
fi

now=$(date +%s)
if [ -f "$STAMP" ]; then
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt 600 ]; then
    logger -t mdown-health "still unhealthy (HTTP $code), waiting before another restart"
    exit 0
  fi
fi

logger -t mdown-health "health check returned HTTP $code — restarting mdown-api"
echo "$now" > "$STAMP"
systemctl restart mdown-api.service

# give it a moment, then say plainly whether that worked
sleep 8
after=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$URL" 2>/dev/null || true)
[ -n "$after" ] || after=000
if [ "$after" = "200" ]; then
  logger -t mdown-health "restart fixed it"
  rm -f "$STAMP"
else
  logger -t mdown-health "restart did NOT fix it (HTTP $after) — needs a human"
fi
