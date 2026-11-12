#!/usr/bin/env bash
# Provision the mdown API host on Oracle Cloud, entirely via OCI CLI.
# Idempotent-ish: reuses an existing VCN/subnet with the same names.
set -uo pipefail

KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4XxOGTGKmumpcyN32nY+pVZRDh/C1MKIg8e0jX9p17 mdown-api"
T=$(grep -m1 '^tenancy' "$HOME/.oci/config" | cut -d= -f2 | tr -d ' \r')
echo "tenancy: $T"

# ---- VCN ---------------------------------------------------------------
VCN=$(oci network vcn list -c "$T" --display-name mdown-vcn --query 'data[0].id' --raw-output 2>/dev/null)
if [ -z "$VCN" ] || [ "$VCN" = "null" ]; then
  VCN=$(oci network vcn create -c "$T" --cidr-block 10.0.0.0/16 \
        --display-name mdown-vcn --dns-label mdown \
        --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
echo "vcn: $VCN"

# ---- internet gateway + default route ----------------------------------
IGW=$(oci network internet-gateway list -c "$T" --vcn-id "$VCN" --query 'data[0].id' --raw-output 2>/dev/null)
if [ -z "$IGW" ] || [ "$IGW" = "null" ]; then
  IGW=$(oci network internet-gateway create -c "$T" --vcn-id "$VCN" --is-enabled true \
        --display-name mdown-igw --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
echo "igw: $IGW"

RT=$(oci network route-table list -c "$T" --vcn-id "$VCN" --query 'data[0].id' --raw-output)
oci network route-table update --rt-id "$RT" --force \
  --route-rules '[{"destination":"0.0.0.0/0","destinationType":"CIDR_BLOCK","networkEntityId":"'"$IGW"'"}]' >/dev/null
echo "route: ok"

# ---- security list: 22, 80, 443 ----------------------------------------
SL=$(oci network security-list list -c "$T" --vcn-id "$VCN" --query 'data[0].id' --raw-output)
oci network security-list update --security-list-id "$SL" --force \
  --ingress-security-rules '[{"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},{"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},{"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":443,"max":443}}}]' >/dev/null
echo "security list: ok"

# ---- subnet ------------------------------------------------------------
SUBNET=$(oci network subnet list -c "$T" --vcn-id "$VCN" --display-name mdown-subnet --query 'data[0].id' --raw-output 2>/dev/null)
if [ -z "$SUBNET" ] || [ "$SUBNET" = "null" ]; then
  SUBNET=$(oci network subnet create -c "$T" --vcn-id "$VCN" --cidr-block 10.0.0.0/24 \
           --display-name mdown-subnet --dns-label mdown \
           --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
echo "subnet: $SUBNET"

# ---- image (Ubuntu 24.04 arm64) ---------------------------------------
IMG=$(oci compute image list -c "$T" --operating-system 'Canonical Ubuntu' \
      --shape VM.Standard.A1.Flex --all --output json 2>/dev/null \
      | python3 -c "import json,sys
d=json.load(sys.stdin).get('data',[])
c=[x['id'] for x in d if '24.04' in x.get('display-name','') and 'aarch64' in x.get('display-name','')]
print(c[0] if c else '')")
echo "image: $IMG"

AD=$(oci iam availability-domain list --query 'data[0].name' --raw-output)
echo "ad: $AD"

# ---- instance ----------------------------------------------------------
EXISTING=$(oci compute instance list -c "$T" --display-name mdown-api --query 'data[?\"lifecycle-state\"!=`TERMINATED`] | [0].id' --raw-output 2>/dev/null)
if [ -n "$EXISTING" ] && [ "$EXISTING" != "null" ]; then
  echo "instance already exists: $EXISTING"
else
  oci compute instance launch -c "$T" --availability-domain "$AD" \
    --shape VM.Standard.A1.Flex --shape-config '{"ocpus":2,"memoryInGBs":12}' \
    --image-id "$IMG" --subnet-id "$SUBNET" --assign-public-ip true \
    --display-name mdown-api \
    --metadata '{"ssh_authorized_keys":"'"$KEY"'"}' \
    --wait-for-state RUNNING --query 'data.id' --raw-output
fi

# ---- report ------------------------------------------------------------
IP=$(oci compute instance list-vnics -c "$T" \
     --instance-id "$(oci compute instance list -c "$T" --display-name mdown-api --query 'data[0].id' --raw-output)" \
     --query 'data[0]."public-ip"' --raw-output 2>/dev/null)
echo "PUBLIC_IP=$IP"
echo "PROVISION_DONE"
