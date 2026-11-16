#!/bin/sh
# Ask the API whether it is healthy, and restart it only when the process
# itself is gone or wedged.
#
# systemd restarts a process that dies, but not one that is alive and wedged:
# a stuck thread, an exhausted thread pool, or a job holding a lock forever.
# This is the check that notices.
#
# It must NOT restart a merely degraded box. /health answers 503 with
# {"status":"degraded", ...} when yt-dlp/ffmpeg is missing or the disk is
# nearly full: the process is fine, a restart cannot install a tool or free
# space, and doing it anyway kills live downloads every ten minutes forever.
# The same goes for any 4xx (a 429 from the read limiter, a 401 when
# MDOWN_API_KEY is set) — those are answers from a process that is up.
#
# A restart storm is worse than a broken service, so a restart only happens
# once every 10 minutes and logs what it saw.
set -eu

URL="http://127.0.0.1:9000/health"
STAMP="/run/mdown-health.restarted"
# /run rather than /tmp: root-owned, not world-writable
BODY="/run/mdown-health.body"

# "ok", "degraded", or empty when the response was not a health document
health_status() {
  sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$BODY" 2>/dev/null | head -n 1
}

# names of the checks the API reported as false, for the log line.
# sed/tr only — this box has no jq and must not grow a dependency.
failed_checks() {
  tr ',{}' '\n\n\n' < "$BODY" 2>/dev/null |
    sed -n 's/.*"\([A-Za-z][A-Za-z-]*\)"[[:space:]]*:[[:space:]]*false.*/\1/p' |
    tr '\n' ' ' || true
}

code=000
status=""
probe() {
  code=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 12 "$URL" 2>/dev/null || true)
  [ -n "$code" ] || code=000
  status=$(health_status || true)
}

probe

# 1. Up, answering, and telling us what is wrong with the box. Report it and
#    change nothing. Written to match either 503 (what the API does today) or
#    200 with a degraded body (should that ever change).
if [ "$status" = "degraded" ]; then
  failed=$(failed_checks || true)
  logger -t mdown-health "degraded (HTTP $code): ${failed:-unknown check} failed — not restarting, a restart cannot fix this"
  exit 0
fi

# 2. Healthy.
if [ "$code" = "200" ]; then
  rm -f "$STAMP" "$BODY"
  exit 0
fi

# 3. Restart only for an unreachable API (000: refused, timed out, no route) or
#    a 5xx that is not the degraded case above (500/502/504: crash, wedge, or
#    the proxy failing to reach the backend). Everything else is a live process
#    giving a client-visible answer.
case "$code" in
  000|5??) ;;
  *)
    logger -t mdown-health "unexpected HTTP $code from $URL — not restarting"
    exit 0
    ;;
esac

now=$(date +%s)
if [ -f "$STAMP" ]; then
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  # a truncated or garbled stamp must not kill the script under set -e
  case "$last" in
    ''|*[!0-9]*) last=0 ;;
  esac
  if [ $((now - last)) -lt 600 ]; then
    logger -t mdown-health "still down (HTTP $code), waiting before another restart"
    exit 0
  fi
fi

logger -t mdown-health "health check returned HTTP $code — restarting mdown-api"
echo "$now" > "$STAMP"
systemctl restart mdown-api.service

# give it a moment, then say plainly whether that worked
sleep 8
probe
if [ "$code" = "200" ]; then
  logger -t mdown-health "restart fixed it"
  rm -f "$STAMP" "$BODY"
elif [ "$status" = "degraded" ]; then
  failed=$(failed_checks || true)
  logger -t mdown-health "restarted: API is up but degraded (${failed:-unknown check}) — needs a human"
else
  logger -t mdown-health "restart did NOT fix it (HTTP $code) — needs a human"
fi
