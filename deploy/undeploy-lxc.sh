#!/usr/bin/env bash
#
# undeploy-lxc.sh — Stop and destroy the annas-archive-api LXC on a Proxmox host.
#
# Contains NO secrets. Auth is via your SSH agent / ~/.ssh/config.
# The container is located by hostname (default) or an explicit --vmid.
#
# Usage:
#   ./deploy/undeploy-lxc.sh [options]
#
# Options (defaults in brackets):
#   --host <alias>     SSH host/alias for the Proxmox node   [proxmox]
#   --vmid <id>        Container VMID to destroy             [auto: match by hostname]
#   --hostname <name>  Hostname to match when --vmid omitted [annas-archive-api]
#   --yes              Skip the confirmation prompt
#   -h, --help         show this help and exit
#
set -euo pipefail

PVE_HOST="proxmox"
VMID=""
CT_HOSTNAME="annas-archive-api"
ASSUME_YES=0

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host)      PVE_HOST="$2";    shift 2 ;;
    --vmid)      VMID="$2";        shift 2 ;;
    --hostname)  CT_HOSTNAME="$2"; shift 2 ;;
    --yes)       ASSUME_YES=1;     shift ;;
    -h|--help)   usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

SSH() { ssh -o StrictHostKeyChecking=accept-new "$PVE_HOST" "$@"; }

command -v ssh >/dev/null 2>&1 || die "'ssh' is required."
log "Checking SSH access to '$PVE_HOST'…"
SSH true 2>/dev/null || die "Cannot SSH to '$PVE_HOST'. Ensure your key is loaded (ssh-add -l)."

# ---------------------------------------------------------------------------
# Resolve the VMID
# ---------------------------------------------------------------------------
if [ -z "$VMID" ]; then
  log "Locating container by hostname '$CT_HOSTNAME'…"
  # Match the hostname line in each CT config; print the VMID(s).
  MATCHES="$(SSH "for f in /etc/pve/lxc/*.conf; do id=\$(basename \"\$f\" .conf); if grep -qxF 'hostname: $CT_HOSTNAME' \"\$f\"; then echo \$id; fi; done")"
  COUNT="$(printf '%s\n' "$MATCHES" | grep -c . || true)"
  [ "$COUNT" = "0" ] && die "No container found with hostname '$CT_HOSTNAME'. Pass --vmid explicitly."
  [ "$COUNT" -gt 1 ] && die "Multiple containers match '$CT_HOSTNAME': $MATCHES. Pass --vmid explicitly."
  VMID="$(printf '%s' "$MATCHES" | tr -d '[:space:]')"
fi

SSH "test -f /etc/pve/lxc/$VMID.conf" || die "No LXC config for VMID $VMID on '$PVE_HOST'."

REAL_HOST="$(SSH "grep '^hostname:' /etc/pve/lxc/$VMID.conf | awk '{print \$2}'")"
STATUS="$(SSH "pct status $VMID | awk '{print \$2}'")"
log "Target: VMID $VMID  (hostname: ${REAL_HOST:-?}, status: ${STATUS:-?}) on '$PVE_HOST'."

# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------
if [ "$ASSUME_YES" != "1" ]; then
  printf '\033[1;33mThis will PERMANENTLY stop and destroy CT %s and its rootfs. Continue? [y/N] \033[0m' "$VMID"
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) log "Aborted — nothing changed."; exit 0 ;;
  esac
fi

# ---------------------------------------------------------------------------
# Stop and destroy
# ---------------------------------------------------------------------------
if [ "$STATUS" = "running" ]; then
  log "Stopping container $VMID…"
  SSH "pct shutdown $VMID --timeout 30 || pct stop $VMID"
fi

log "Destroying container $VMID (with its rootfs)…"
SSH "pct destroy $VMID --purge"

log "Done. CT $VMID removed."
SSH "test -f /etc/pve/lxc/$VMID.conf" && die "Config still present — destroy may have failed." || true
log "Verified: /etc/pve/lxc/$VMID.conf is gone."
