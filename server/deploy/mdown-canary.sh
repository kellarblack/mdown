#!/bin/sh
# Does extraction still work, not just "is the process alive".
#
# The health timer answers whether the API is up. This answers whether the
# sites it depends on still parse, because that is what visitors actually hit.
# One cheap metadata probe per service, once a day. Nothing is downloaded.
#
# When a service fails, the yt-dlp updater is started once: most breakage is a
# site change and a newer release is the fix. The updater restarts the API only
# if the version actually moved, so this cannot loop.
set -eu

WORK=/var/lib/mdown/jobs
BODY=/run/mdown-canary.body
OUT="$WORK/canary.json"
STAMP=/var/lib/mdown/canary-trigger

mkdir -p "$WORK"

# one stable, public link per service. A probe is metadata only.
probe() {
  name="$1"; url="$2"
  code=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 45 \
    -X POST http://127.0.0.1:9000/probe \
    -H 'Content-Type: application/json' -H 'Origin: https://mdown.cc' \
    --data "{\"url\":\"$url\",\"downloadMode\":\"audio\"}" || echo 000)
  if [ "$code" = "200" ] && grep -q '"status": *"ok"' "$BODY"; then
    echo "$name ok"
  else
    echo "$name FAIL ($code)"
    echo "$name" >> /run/mdown-canary.failed
  fi
}

: > /run/mdown-canary.failed
probe youtube   'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
probe soundcloud 'https://soundcloud.com/forss/flickermood'
probe x         'https://x.com/SpaceX/status/1732824684683784516'
probe tiktok    'https://www.tiktok.com/@scout2015/video/6718335390845095173'
probe streamable 'https://streamable.com/moo'

failed=$(wc -l < /run/mdown-canary.failed | tr -d ' ')
now=$(date +%s)
printf '{"at":%s,"failed":%s,"of":5,"services":"%s"}\n' \
  "$now" "$failed" "$(tr '\n' ' ' < /run/mdown-canary.failed | sed 's/  *$//')" > "$OUT"

# only services this server can fetch are checked: reddit, vimeo and bandcamp
# refuse datacenter addresses, so testing them would only ever say "failed".
# youtube or soundcloud failing means the extractor fell behind a site change:
# fetch the newest yt-dlp now instead of waiting for the six-hourly run.
if grep -qx 'youtube\|soundcloud' /run/mdown-canary.failed; then
  last=0
  [ -f "$STAMP" ] && last=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ $((now - last)) -gt 3600 ]; then
    echo "$now" > "$STAMP"
    /usr/bin/systemctl start mdown-ytdlp-update.service || true
  fi
fi
exit 0
