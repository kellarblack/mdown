#!/usr/bin/env bash
# Build the Go API here and run it on the VM.
#
#   api/deploy/deploy.sh <ip> stage      # run beside the live API on 127.0.0.1:9100
#   api/deploy/deploy.sh <ip> smoke      # real downloads against the staging copy
#   api/deploy/deploy.sh <ip> switch     # make it the live API on :9000
#   api/deploy/deploy.sh <ip> rollback   # back to the Python API
#
# The VM needs what server/deploy/install.sh already set up: the mdown user,
# /etc/mdown/api.env, the yt-dlp venv, ffmpeg and Caddy. Nothing else changes.
set -euo pipefail

IP="${1:?usage: deploy.sh <ip> stage|smoke|switch|rollback}"
STEP="${2:?usage: deploy.sh <ip> stage|smoke|switch|rollback}"
SSH_KEY="${MDOWN_SSH_KEY:-}"
if [ -z "$SSH_KEY" ]; then
  for candidate in "$HOME/.ssh/mdown" "$HOME/.ssh/mdown_dedi" "$HOME/.ssh/mdown_oracle"; do
    if [ -f "$candidate" ]; then SSH_KEY="$candidate"; break; fi
  done
fi
[ -f "$SSH_KEY" ] || { echo "no ssh key (set MDOWN_SSH_KEY)"; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # -> api/
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@$IP")
GO="${GO:-$(command -v go || echo "$HOME/.local/go/bin/go")}"

build_and_copy() {
  echo "==> testing"
  (cd "$HERE" && "$GO" test -count=1 ./... >/dev/null)
  echo "==> building linux/$ARCH"
  (cd "$HERE" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" "$GO" build -trimpath -ldflags "-s -w" -o "$HERE/dist/mdown-api" ./cmd/mdown-api)
  echo "==> copying"
  "${SSH[@]}" 'install -d -m 0755 /opt/mdown/bin'
  scp -i "$SSH_KEY" -q "$HERE/dist/mdown-api" "root@$IP:/opt/mdown/bin/mdown-api.new"
  scp -i "$SSH_KEY" -q "$HERE/deploy/mdown-api.service" "root@$IP:/opt/mdown/bin/mdown-api-go.service"
  "${SSH[@]}" 'chmod 0755 /opt/mdown/bin/mdown-api.new && /opt/mdown/bin/mdown-api.new -h >/dev/null 2>&1; true'
}

case "$(${SSH[@]} uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unknown arch"; exit 1 ;;
esac

case "$STEP" in
  stage)
    build_and_copy
    "${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
systemctl stop mdown-go-staging 2>/dev/null || true
systemctl reset-failed mdown-go-staging 2>/dev/null || true
install -d -m 0700 -o mdown -g mdown /var/lib/mdown/jobs-staging
cp /opt/mdown/bin/mdown-api.new /opt/mdown/bin/mdown-api-staging
# the live settings, with a port and a work folder of its own
sed -e 's#^MDOWN_PORT=.*#MDOWN_PORT=9100#' -e 's#^MDOWN_WORK_DIR=.*#MDOWN_WORK_DIR=/var/lib/mdown/jobs-staging#' \
    -e 's#^MDOWN_API_URL=.*#MDOWN_API_URL=http://127.0.0.1:9100/#' /etc/mdown/api.env > /etc/mdown/api-staging.env
grep -q '^MDOWN_PORT=' /etc/mdown/api-staging.env || echo 'MDOWN_PORT=9100' >> /etc/mdown/api-staging.env
grep -q '^MDOWN_WORK_DIR=' /etc/mdown/api-staging.env || echo 'MDOWN_WORK_DIR=/var/lib/mdown/jobs-staging' >> /etc/mdown/api-staging.env
chmod 0600 /etc/mdown/api-staging.env
systemd-run --unit=mdown-go-staging --collect \
  -p User=mdown -p Group=mdown -p EnvironmentFile=/etc/mdown/api-staging.env \
  -p MemoryMax=1G -p ReadWritePaths=/var/lib/mdown -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
  -E PATH=/opt/mdown/venv/bin:/usr/local/bin:/usr/bin:/bin \
  -E GOMEMLIMIT=384MiB \
  /opt/mdown/bin/mdown-api-staging
sleep 2
systemctl --no-pager --lines=5 status mdown-go-staging || true
curl -s http://127.0.0.1:9100/health; echo
REMOTE
    ;;
  smoke)
    "${SSH[@]}" 'bash -s' <<'REMOTE'
set -uo pipefail
API=http://127.0.0.1:9100
ORIGIN="$(grep -E '^MDOWN_CORS_ORIGINS=' /etc/mdown/api.env | cut -d= -f2 | cut -d, -f1)"
ORIGIN="${ORIGIN:-https://mdown.cc}"
fail=0
try() { # name, body
  local name="$1" body="$2" t0 t1 res url size code
  t0=$(date +%s.%N)
  res=$(curl -s -m 120 -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "$body" "$API/")
  t1=$(date +%s.%N)
  url=$(printf '%s' "$res" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("url",""))' 2>/dev/null)
  if [ -z "$url" ]; then echo "FAIL $name: $res"; fail=1; return; fi
  url="$API/tunnel/${url##*/tunnel/}"
  rm -f /tmp/smoke.bin
  code=$(curl -s -m 300 -o /tmp/smoke.bin -w '%{http_code} %{time_starttransfer} %{time_total} %{size_download}' "$url")
  printf '%-14s resolve %.2fs | tunnel %s\n' "$name" "$(echo "$t1 - $t0" | bc)" "$code"
  ffprobe -v error -show_entries stream=codec_type,codec_name,height -of csv=p=0 /tmp/smoke.bin | tr '\n' ' '; echo
}
# the first video ever uploaded: 19 seconds, public, stable since 2005
try video-720  '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","videoQuality":"720"}'
try video-1080 '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","videoQuality":"1080","subtitleLang":"en"}'
try mute       '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","downloadMode":"mute"}'
try audio-mp3  '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","downloadMode":"audio","audioFormat":"mp3","audioCovers":true}'
try audio-best '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","downloadMode":"audio","audioFormat":"best"}'
try audio-opus '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","downloadMode":"audio","audioFormat":"opus","audioCovers":false}'
journalctl -u mdown-go-staging --no-pager -n 25 | grep -v ' 200 ' | tail -12
exit $fail
REMOTE
    ;;
  switch)
    build_and_copy
    "${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
# keep the Python unit for a rollback
if [ ! -f /etc/systemd/system/mdown-api-python.service ] && grep -q mdown_api /etc/systemd/system/mdown-api.service; then
  cp /etc/systemd/system/mdown-api.service /etc/systemd/system/mdown-api-python.service
fi
mv /opt/mdown/bin/mdown-api.new /opt/mdown/bin/mdown-api
install -m 0644 /opt/mdown/bin/mdown-api-go.service /etc/systemd/system/mdown-api.service
systemctl stop mdown-go-staging 2>/dev/null || true
systemctl daemon-reload
systemctl restart mdown-api
sleep 2
systemctl --no-pager --lines=8 status mdown-api || true
curl -s http://127.0.0.1:9000/health; echo
REMOTE
    ;;
  rollback)
    "${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
[ -f /etc/systemd/system/mdown-api-python.service ] || { echo "no python unit saved"; exit 1; }
cp /etc/systemd/system/mdown-api-python.service /etc/systemd/system/mdown-api.service
systemctl daemon-reload
systemctl restart mdown-api
sleep 2
curl -s http://127.0.0.1:9000/health; echo
REMOTE
    ;;
  *) echo "unknown step: $STEP"; exit 1 ;;
esac
