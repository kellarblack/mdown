#!/usr/bin/env bash
# Provision the mdown API on a fresh Ubuntu 22.04/24.04 ARM64 VM.
# Run as root from the directory that contains this script's parent,
# i.e. after copying `server/` to the VM.
#
#   sudo bash /tmp/server/deploy/install.sh
#
# Idempotent: safe to re-run after a code copy.
set -euo pipefail

API_DOMAIN="${API_DOMAIN:-api.mdown.cc}"
SITE_ORIGIN="${SITE_ORIGIN:-https://mdown.cc}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP_USER=mdown
APP_ROOT=/opt/mdown
DATA_ROOT=/var/lib/mdown
CONF_DIR=/etc/mdown

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get -y upgrade -qq
apt-get -y install -qq --no-install-recommends \
  python3 python3-venv python3-pip ffmpeg ca-certificates curl rsync \
  unattended-upgrades fail2ban

echo "==> unattended security updates"
# patches install themselves nightly; no reboot without you deciding to
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
APT
cat > /etc/apt/apt.conf.d/51unattended-no-reboot <<'APT'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
APT
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

echo "==> ssh hardening"
# key-only login, no root password, and a brute-force ban after 5 tries
install -d -m 0755 /etc/ssh/sshd_config.d
# 00- matters: sshd takes the FIRST value it sees, and cloud-init ships
# 50-cloud-init.conf with "PasswordAuthentication yes". A 99- prefixed file
# loses to it, so password logins stay on while the config looks hardened.
rm -f /etc/ssh/sshd_config.d/99-mdown.conf
cat > /etc/ssh/sshd_config.d/00-mdown.conf <<'SSH'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin prohibit-password
MaxAuthTries 5
SSH
sshd -t
ssh-keygen -A >/dev/null 2>&1 || true
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true

cat > /etc/fail2ban/jail.d/mdown.local <<'F2B'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
F2B
systemctl enable --now fail2ban >/dev/null 2>&1 || true

echo "==> swap (a 1 GB box needs headroom for ffmpeg merges)"
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
fi
swapon /swapfile 2>/dev/null || true
grep -q "^/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
# keep swap as a safety net, not as working memory
sysctl -qw vm.swappiness=10

echo "==> cap the journal so logs cannot fill the disk"
install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/mdown.conf <<'JOURNAL'
[Journal]
SystemMaxUse=200M
SystemMaxFileSize=20M
JOURNAL
systemctl restart systemd-journald 2>/dev/null || true

echo "==> service account"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$DATA_ROOT" --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -m 0755 "$APP_ROOT" "$APP_ROOT/api"
install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$DATA_ROOT" "$DATA_ROOT/jobs" "$DATA_ROOT/cache"
install -d -m 0750 -o root -g "$APP_USER" "$CONF_DIR"

echo "==> application code"
# the API package is copied, not cloned: the VM holds no git remote
rsync -a --delete "$SRC_DIR/mdown_api/" "$APP_ROOT/api/mdown_api/"
install -m 0644 "$SRC_DIR/requirements.txt" "$APP_ROOT/api/requirements.txt"

echo "==> python environment"
if [ ! -x "$APP_ROOT/venv/bin/python" ]; then
  python3 -m venv "$APP_ROOT/venv"
fi
"$APP_ROOT/venv/bin/pip" install --quiet --upgrade pip
"$APP_ROOT/venv/bin/pip" install --quiet --upgrade yt-dlp

echo "==> environment file"
if [ ! -f "$CONF_DIR/api.env" ]; then
  cat > "$CONF_DIR/api.env" <<ENV
# mdown API configuration. mode 0600, owned by root; systemd reads it before
# dropping to the mdown user, so the service account never needs read access.
MDOWN_HOST=127.0.0.1
MDOWN_PORT=9000
MDOWN_API_URL=https://${API_DOMAIN}/
MDOWN_CORS_ORIGINS=${SITE_ORIGIN}
MDOWN_TRUST_PROXY=1

# media limits
MDOWN_MAX_HEIGHT=4320
MDOWN_MAX_DURATION=1800
MDOWN_MAX_OUTPUT_MB=2048

# capacity, sized for 2 OCPU / 12 GB
MDOWN_MAX_CONCURRENT=2
# parallel range requests per download: 8 measured ~40% faster than 4 here
MDOWN_FRAGMENTS=8
MDOWN_MAX_QUEUE=6
MDOWN_JOB_TIMEOUT=300
MDOWN_PROBE_TIMEOUT=45
MDOWN_JOB_TTL=900
MDOWN_MIN_FREE_MB=3072

# request frequency
MDOWN_RATE_MAX=30
MDOWN_RATE_WINDOW=60
MDOWN_TUNNEL_RATE_MAX=120

# downloads per IP. A person batching a few links is fine; a scraper is not.
MDOWN_JOB_RATE_MAX=60
MDOWN_JOB_RATE_WINDOW=300

# hard ceiling on jobs per day. Bounds the damage from a scraper, a viral spike
# or a bug that loops: the box cannot be drained. 0 disables it.
MDOWN_DAILY_JOBS=500

# when a source starts asking for a login, point this at a cookies.txt.
# never commit that file anywhere.
# MDOWN_YTDLP_COOKIES=/var/lib/mdown/cookies.txt

# last-resort escape hatch for extractor changes:
# MDOWN_YTDLP_EXTRA_ARGS=--extractor-args "youtube:player_client=tv,web_safari"

MDOWN_WORK_DIR=${DATA_ROOT}/jobs

# leave empty to run open to anyone who knows the hostname
MDOWN_API_KEY=
ENV
  chmod 0600 "$CONF_DIR/api.env"
else
  echo "    keeping existing $CONF_DIR/api.env"
fi

echo "==> systemd"
install -m 0644 "$SRC_DIR/deploy/mdown-api.service" /etc/systemd/system/mdown-api.service
install -m 0644 "$SRC_DIR/deploy/mdown-ytdlp-update.service" /etc/systemd/system/mdown-ytdlp-update.service
install -m 0644 "$SRC_DIR/deploy/mdown-ytdlp-update.timer" /etc/systemd/system/mdown-ytdlp-update.timer
systemctl daemon-reload
# enable on boot, then RESTART — `enable --now` is a no-op on a running service,
# which means a redeploy would keep executing the old code
systemctl enable mdown-api.service >/dev/null 2>&1 || true
systemctl restart mdown-api.service
# keep yt-dlp current: a site change is the most common way this breaks
systemctl enable --now mdown-ytdlp-update.timer
sleep 1
systemctl --no-pager --lines=5 status mdown-api.service || true
systemctl --no-pager list-timers mdown-ytdlp-update.timer --all || true

echo "==> log rotation (journald handles the rest)"
cat > /etc/logrotate.d/mdown-api <<'ROTATE'
/var/log/mdown/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
ROTATE

echo
echo "done. next:"
echo "  1. install caddy and use deploy/Caddyfile with API_DOMAIN=$API_DOMAIN"
echo "  2. curl -s https://${API_DOMAIN}/health"
echo "  3. curl -s https://${API_DOMAIN}/ | head -c 400"
