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
probe bandcamp  'https://bandcamp.com/discover/electronic'
probe reddit    'https://www.reddit.com/r/interestingasfuck/comments/1cjx6vb/the_way_this_dog_looks_at_his_owner/'
probe vimeo     'https://vimeo.com/76979871'

failed=$(wc -l < /run/mdown-canary.failed | tr -d ' ')
now=$(date +%s)
printf '{"at":%s,"failed":%s,"of":5,"services":"%s"}\n' \
  "$now" "$failed" "$(tr '\n' ' ' < /run/mdown-canary.failed | sed 's/  *$//')" > "$OUT"

# a bad day for one service is normal; two or more is a broken extractor
if [ "$failed" -ge 2 ]; then
  last=0
  [ -f "$STAMP" ] && last=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ $((now - last)) -gt 43200 ]; then
    echo "$now" > "$STAMP"
    /usr/bin/systemctl start mdown-ytdlp-update.service || true
  fi
fi
exit 0
