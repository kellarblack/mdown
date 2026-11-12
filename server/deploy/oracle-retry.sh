#!/usr/bin/env bash
# Keep trying to launch the free mdown-api VM on Oracle Cloud until capacity appears.
#
# Each round tries VM.Standard.A1.Flex (ARM, Always Free), then VM.Standard.E2.1.Micro
# (x86, Always Free), each with a matching Ubuntu 24.04 image. On "Out of capacity" it
# waits and tries again. It stops on success or on any other error.
#
# Needs: OCI CLI installed and signed in (~/.oci/config), and a public subnet.
#
# Usage:
#   caffeinate -i bash oracle-retry.sh          # caffeinate keeps the Mac awake
#
# Options (environment variables):
#   INTERVAL=120          seconds between rounds
#   OCPUS=2 MEM_GB=12     A1.Flex size (Always Free max is 4 OCPU / 24 GB in total)
#   SHAPES="A1 MICRO"     which shapes to try, in order ("A1", "MICRO" or both)
#   SUBNET_ID=ocid1...    subnet to use (default: mdown-subnet, else first public one)
#   SSH_KEY_FILE=...      public key (default: ~/.ssh/mdown_oracle.pub)
set -uo pipefail

NAME="mdown-api"
INTERVAL="${INTERVAL:-120}"
OCPUS="${OCPUS:-2}"
MEM_GB="${MEM_GB:-12}"
SHAPES="${SHAPES:-A1 MICRO}"
SSH_KEY_FILE="${SSH_KEY_FILE:-$HOME/.ssh/mdown_oracle.pub}"
OUT_FILE="$(cd "$(dirname "$0")" && pwd)/oracle-instance.txt"

log()    { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die()    { log "ERROR: $*"; exit 1; }
notify() { osascript -e "display notification \"$1\" with title \"Oracle retry\" sound name \"Glass\"" >/dev/null 2>&1 || true; }

# ---- preflight ---------------------------------------------------------
# The OCI CLI is installed in its own Python venv at ~/.local/oci-cli.
[ -x "$HOME/.local/oci-cli/bin/oci" ] && PATH="$HOME/.local/oci-cli/bin:$PATH"
command -v oci >/dev/null || die "OCI CLI not found. Install: brew install oci-cli   then: oci setup config"
[ -f "$HOME/.oci/config" ] || die "No ~/.oci/config. Run: oci setup config"
[ -f "$SSH_KEY_FILE" ]     || die "SSH public key not found: $SSH_KEY_FILE"

T=$(grep -m1 '^tenancy' "$HOME/.oci/config" | cut -d= -f2 | tr -d ' \r')
[ -n "$T" ] || die "Could not read tenancy from ~/.oci/config"

AD=$(oci iam availability-domain list -c "$T" --query 'data[0].name' --raw-output 2>&1) \
  || die "OCI CLI cannot sign in: $AD"
log "availability domain: $AD"

if [ -z "${SUBNET_ID:-}" ]; then
  SUBNET_ID=$(oci network subnet list -c "$T" --display-name mdown-subnet \
              --query 'data[0].id' --raw-output 2>/dev/null)
  if [ -z "$SUBNET_ID" ] || [ "$SUBNET_ID" = "null" ]; then
    SUBNET_ID=$(oci network subnet list -c "$T" \
                --query 'data[?"prohibit-public-ip-on-vnic"==`false`] | [0].id' --raw-output 2>/dev/null)
  fi
fi
[ -n "$SUBNET_ID" ] && [ "$SUBNET_ID" != "null" ] \
  || die "No public subnet found. Create a VCN with a public subnet, or set SUBNET_ID."
log "subnet: $SUBNET_ID"

# Newest Ubuntu 24.04 platform image for a shape. $2 = "arm" or "x86".
find_image() {
  oci compute image list -c "$T" --operating-system 'Canonical Ubuntu' \
      --operating-system-version '24.04' --shape "$1" --all \
      --sort-by TIMECREATED --sort-order DESC --output json 2>/dev/null \
  | python3 -c "
import json, sys
want_arm = sys.argv[1] == 'arm'
try:
    data = json.load(sys.stdin).get('data', [])
except Exception:
    data = []
for img in data:
    n = img.get('display-name', '')
    if 'Minimal' in n:
        continue
    if ('aarch64' in n) == want_arm:
        print(img['id']); break
" "$2"
}

IMG_A1=""; IMG_MICRO=""
for s in $SHAPES; do
  case "$s" in
    A1)    IMG_A1=$(find_image VM.Standard.A1.Flex arm)
           [ -n "$IMG_A1" ] || die "No Ubuntu 24.04 aarch64 image found for A1.Flex"
           log "A1 image: $IMG_A1" ;;
    MICRO) IMG_MICRO=$(find_image VM.Standard.E2.1.Micro x86)
           [ -n "$IMG_MICRO" ] || die "No Ubuntu 24.04 x86 image found for E2.1.Micro"
           log "Micro image: $IMG_MICRO" ;;
    *)     die "Unknown shape in SHAPES: $s (use A1 and/or MICRO)" ;;
  esac
done

# ---- helpers -----------------------------------------------------------
existing_instance() {
  oci compute instance list -c "$T" --display-name "$NAME" \
    --query 'data[?"lifecycle-state"!=`TERMINATED`] | [0].id' --raw-output 2>/dev/null
}

finish() {
  local id="$1"
  log "Instance exists: $id. Waiting for RUNNING..."
  oci compute instance get --instance-id "$id" --wait-for-state RUNNING \
      --max-wait-seconds 900 >/dev/null 2>&1 || true
  local ip
  ip=$(oci compute instance list-vnics -c "$T" --instance-id "$id" \
       --query 'data[0]."public-ip"' --raw-output 2>/dev/null)
  {
    echo "INSTANCE_ID=$id"
    echo "PUBLIC_IP=$ip"
    echo "CREATED=$(date '+%Y-%m-%d %H:%M:%S')"
  } > "$OUT_FILE"
  log "SUCCESS. PUBLIC_IP=$ip  (saved to $OUT_FILE)"
  log "Next: bash mdown/server/deploy/deploy-to.sh $ip"
  notify "VM created: $ip"
  exit 0
}

# Returns 0 = launched, 1 = no capacity (retry), 2 = rate limited, 3 = shape limit hit (skip), 4 = other error.
try_launch() {
  local shape="$1" img="$2" extra=() out
  [ "$shape" = "VM.Standard.A1.Flex" ] && extra=(--shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEM_GB}")
  out=$(oci compute instance launch -c "$T" --availability-domain "$AD" \
          --shape "$shape" ${extra[@]+"${extra[@]}"} --image-id "$img" \
          --subnet-id "$SUBNET_ID" --assign-public-ip true \
          --display-name "$NAME" --ssh-authorized-keys-file "$SSH_KEY_FILE" \
          --query 'data.id' --raw-output 2>&1)
  if [[ "$out" == ocid1.instance.* ]]; then LAUNCHED_ID="$out"; return 0; fi
  case "$out" in
    *"ut of capacity"*|*"ut of host capacity"*) return 1 ;;
    *TooManyRequests*|*"429"*)                   return 2 ;;
    *LimitExceeded*|*"service limit"*)           LAST_ERR="$out"; return 3 ;;
    *)                                           LAST_ERR="$out"; return 4 ;;
  esac
}

# ---- main loop ---------------------------------------------------------
trap 'log "Stopped by user."; exit 130' INT TERM
round=0
while true; do
  round=$((round + 1))
  id=$(existing_instance)
  [ -n "$id" ] && [ "$id" != "null" ] && finish "$id"

  wait_s="$INTERVAL"
  tried=0
  for s in $SHAPES; do
    case "$s" in
      A1)    shape=VM.Standard.A1.Flex;    img="$IMG_A1" ;;
      MICRO) shape=VM.Standard.E2.1.Micro; img="$IMG_MICRO" ;;
    esac
    tried=$((tried + 1))
    try_launch "$shape" "$img"; rc=$?
    case $rc in
      0) finish "$LAUNCHED_ID" ;;
      1) log "round $round: $shape out of capacity" ;;
      2) log "round $round: rate limited, waiting longer"; wait_s=$((INTERVAL * 3)); break ;;
      3) log "round $round: $shape limit reached, removing it from the list: $LAST_ERR"
         SHAPES=$(echo "$SHAPES" | tr ' ' '\n' | grep -vx "$s" | tr '\n' ' ')
         [ -n "${SHAPES// /}" ] || die "No shapes left to try." ;;
      4) die "$shape launch failed with an unexpected error:
$LAST_ERR" ;;
    esac
    sleep 5
  done
  sleep "$wait_s"
done
