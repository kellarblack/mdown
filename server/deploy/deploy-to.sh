#!/usr/bin/env bash
# Deploy the mdown API to an existing Ubuntu VM.
#
#   ./deploy-to.sh <public-ip> [ssh-user] [ssh-key]
#
# Runs from this machine; does all server-side work over SSH on the VM.
# Nothing is installed locally.
set -euo pipefail

IP="${1:?usage: deploy-to.sh <public-ip> [ssh-user] [ssh-key]}"
USER_NAME="${2:-ubuntu}"
SSH_KEY="${3:-$HOME/.ssh/mdown_oracle}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # -> server/

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$USER_NAME@$IP")

echo "==> waiting for ssh on $IP"
for _ in $(seq 1 30); do
  if "${SSH[@]}" true 2>/dev/null; then break; fi
  sleep 5
done
"${SSH[@]}" 'echo connected: $(uname -m) $(lsb_release -ds 2>/dev/null || cat /etc/os-release | grep PRETTY_NAME)'

echo "==> copying the api"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$USER_NAME@$IP" 'rm -rf /tmp/mdown-server && mkdir -p /tmp/mdown-server'
scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -r "$HERE/." "$USER_NAME@$IP:/tmp/mdown-server/"

echo "==> installing (packages, user, venv, systemd)"
"${SSH[@]}" 'sudo bash /tmp/mdown-server/deploy/install.sh'

echo "==> installing caddy"
"${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
fi
sudo cp /tmp/mdown-server/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy || sudo systemctl restart caddy
REMOTE

echo "==> service state"
"${SSH[@]}" 'systemctl --no-pager --lines=0 is-active mdown-api; curl -s http://127.0.0.1:9000/health || true'

echo
echo "done. public checks:"
echo "  curl -s https://api.mdown.cc/health"
echo "  python3 server/deploy/verify.py"
