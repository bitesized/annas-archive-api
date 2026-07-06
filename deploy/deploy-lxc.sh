#!/usr/bin/env bash
#
# deploy-lxc.sh — Create an unprivileged Debian 13 LXC on a Proxmox host and
# deploy annas-archive-api into it as a systemd service.
#
# Contains NO secrets. Authentication is via your SSH agent / ~/.ssh/config
# (no passwords in this file, none on the command line). Every tunable is a
# --flag with a sensible default discovered from the target host.
#
# Discovered defaults from the target Proxmox host, matching existing CTs:
#   - storage  : local-lvm  (SSD lvmthin) — same pool as the adguard CT
#   - template : local:vztmpl/debian-13-standard (present; ships Node 20 >= 18)
#   - network  : DHCP on vmbr0 (same as the jellyfin CT)
#   - timezone : Pacific/Auckland, onboot, unprivileged, swap 512 (their convention)
#
# The container gets its own IP via DHCP; the app is reachable at
#   http://<container-ip>:<port>
#
# Usage:
#   ./deploy/deploy-lxc.sh [options]
#
# Options (all optional; defaults in brackets):
#   --host <alias>       SSH host/alias for the Proxmox node   [proxmox]
#   --vmid <id>          Container VMID                         [auto: first free >=103]
#   --hostname <name>    Container hostname                     [annas-archive-api]
#   --template <volid>   CT template volume id                  [debian-13-standard]
#   --storage <pool>     rootfs storage pool                    [local-lvm]
#   --disk <GB>          rootfs size in GB                      [4]
#   --cores <n>          vCPUs                                  [1]
#   --memory <MB>        RAM in MB                              [512]
#   --swap <MB>          swap in MB                             [512]
#   --bridge <name>      network bridge                         [vmbr0]
#   --port <port>        app listen port                        [8080]
#   --base-url <url>     ANNAS_BASE_URL for the app             [https://annas-archive.gd]
#   --timezone <tz>      container timezone                     [Pacific/Auckland]
#   --tags <tags>        Proxmox tags                           [annas-archive]
#   -h, --help           show this help and exit
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
PVE_HOST="proxmox"
VMID=""
CT_HOSTNAME="annas-archive-api"
TEMPLATE="local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"
ROOTFS_STORAGE="local-lvm"
DISK_GB=4
CORES=1
RAM_MB=512
SWAP_MB=512
BRIDGE="vmbr0"
APP_PORT=8080
ANNAS_BASE_URL="https://annas-archive.gd"
TIMEZONE="Pacific/Auckland"
TAGS="annas-archive"

APP_DIR="/opt/annas-archive-api"
SERVICE="annas-archive-api"

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# ---------------------------------------------------------------------------
# Parse CLI args
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --host)      PVE_HOST="$2";       shift 2 ;;
    --vmid)      VMID="$2";           shift 2 ;;
    --hostname)  CT_HOSTNAME="$2";    shift 2 ;;
    --template)  TEMPLATE="$2";       shift 2 ;;
    --storage)   ROOTFS_STORAGE="$2"; shift 2 ;;
    --disk)      DISK_GB="$2";        shift 2 ;;
    --cores)     CORES="$2";          shift 2 ;;
    --memory)    RAM_MB="$2";         shift 2 ;;
    --swap)      SWAP_MB="$2";        shift 2 ;;
    --bridge)    BRIDGE="$2";         shift 2 ;;
    --port)      APP_PORT="$2";       shift 2 ;;
    --base-url)  ANNAS_BASE_URL="$2"; shift 2 ;;
    --timezone)  TIMEZONE="$2";       shift 2 ;;
    --tags)      TAGS="$2";           shift 2 ;;
    -h|--help)   usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Auth comes from ssh-agent / ~/.ssh/config — no passwords anywhere here.
SSH() { ssh -o StrictHostKeyChecking=accept-new "$PVE_HOST" "$@"; }

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
for bin in ssh scp tar; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' is required but not installed."
done
[ -f "$PROJECT_ROOT/dev.mjs" ] || die "Can't find project root (dev.mjs missing at $PROJECT_ROOT)."

log "Checking SSH access to '$PVE_HOST' (via ssh-agent / ssh config)…"
SSH true 2>/dev/null || die "Cannot SSH to '$PVE_HOST'. Ensure your key is loaded (ssh-add -l) and the host alias resolves."

# ---------------------------------------------------------------------------
# 1. Pick a free VMID
# ---------------------------------------------------------------------------
if [ -z "$VMID" ]; then
  VMID="$(SSH 'for id in $(seq 103 250); do if ! pct status $id >/dev/null 2>&1 && ! qm status $id >/dev/null 2>&1; then echo $id; break; fi; done')"
  [ -n "$VMID" ] || die "Could not find a free VMID in 103-250."
fi
SSH "pct status $VMID >/dev/null 2>&1 || qm status $VMID >/dev/null 2>&1" \
  && die "VMID $VMID is already taken." || true
log "Using VMID $VMID."

# ---------------------------------------------------------------------------
# 2. Create the container (DHCP, unprivileged — matches existing CTs)
# ---------------------------------------------------------------------------
log "Creating container $VMID ($CT_HOSTNAME) on ${ROOTFS_STORAGE} ..."
SSH "pct create $VMID '$TEMPLATE' \
      --hostname '$CT_HOSTNAME' \
      --cores $CORES --memory $RAM_MB --swap $SWAP_MB \
      --rootfs ${ROOTFS_STORAGE}:${DISK_GB} \
      --net0 name=eth0,bridge=${BRIDGE},ip=dhcp,type=veth \
      --ostype debian --unprivileged 1 --features nesting=1 \
      --onboot 1 --timezone '$TIMEZONE' --tags '$TAGS' \
      --description 'annas-archive-api (deployed via deploy-lxc.sh)'"

log "Starting container…"
SSH "pct start $VMID"

# ---------------------------------------------------------------------------
# 3. Wait for a DHCP lease and capture the container IP
# ---------------------------------------------------------------------------
log "Waiting for DHCP lease…"
CT_IP="$(SSH "for i in \$(seq 1 30); do ip=\$(pct exec $VMID -- ip -4 -o addr show dev eth0 2>/dev/null | awk '{print \$4}' | cut -d/ -f1 | head -1); if [ -n \"\$ip\" ]; then echo \"\$ip\"; exit 0; fi; sleep 2; done; exit 1")" \
  || die "Container did not get an IP via DHCP."
log "Container IP: $CT_IP"

# ---------------------------------------------------------------------------
# 4. Bundle the project (working tree, minus node_modules/.git) and push it in
# ---------------------------------------------------------------------------
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
log "Packaging project…"
tar czf "$TMP/annas-app.tar.gz" -C "$PROJECT_ROOT" \
    --exclude='./node_modules' --exclude='./.git' --exclude='./*.tar.gz' .

cat > "$TMP/provision.sh" <<'PROVISION'
#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq nodejs npm ca-certificates curl >/dev/null
echo "node: $(node --version), npm: $(npm --version)"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
tar xzf /tmp/annas-app.tar.gz -C "$APP_DIR"

cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

cat > "/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=annas-archive-api
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PORT=${APP_PORT}
Environment=ANNAS_BASE_URL=${ANNAS_BASE_URL}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dev.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "${SERVICE}.service"
PROVISION

log "Copying files to the host…"
scp -q -o StrictHostKeyChecking=accept-new "$TMP/annas-app.tar.gz" "$TMP/provision.sh" "$PVE_HOST:/tmp/"

log "Pushing files into the container…"
SSH "pct push $VMID /tmp/annas-app.tar.gz /tmp/annas-app.tar.gz && pct push $VMID /tmp/provision.sh /tmp/provision.sh"

# ---------------------------------------------------------------------------
# 5. Provision inside the container (Node + app + systemd service)
# ---------------------------------------------------------------------------
log "Provisioning inside the container (this pulls Node + npm deps)…"
SSH "pct exec $VMID -- env \
      APP_DIR='$APP_DIR' APP_PORT='$APP_PORT' SERVICE='$SERVICE' \
      ANNAS_BASE_URL='$ANNAS_BASE_URL' \
      bash /tmp/provision.sh"

SSH "rm -f /tmp/annas-app.tar.gz /tmp/provision.sh" || true

# ---------------------------------------------------------------------------
# 6. Smoke test
# ---------------------------------------------------------------------------
log "Smoke-testing http://$CT_IP:$APP_PORT/ …"
if SSH "curl -fsS -m 8 -o /dev/null http://$CT_IP:$APP_PORT/"; then
  STATUS="responding"
else
  STATUS="NOT responding yet (service may still be starting)"
fi

cat <<SUMMARY

------------------------------------------------------------
 Deploy complete
------------------------------------------------------------
 VMID          : $VMID  ($CT_HOSTNAME)
 rootfs pool   : $ROOTFS_STORAGE  (${DISK_GB} GB)
 resources     : ${CORES} vCPU / ${RAM_MB} MB RAM / ${SWAP_MB} MB swap
 network       : DHCP on ${BRIDGE}
 container IP  : $CT_IP
 app URL       : http://$CT_IP:$APP_PORT
 http check    : $STATUS
------------------------------------------------------------
 Manage: ssh $PVE_HOST "pct exec $VMID -- systemctl status $SERVICE"
 Console: ssh $PVE_HOST "pct enter $VMID"
------------------------------------------------------------
SUMMARY
