#!/usr/bin/env bash
# 00-enable-engines.sh — enable the transit + kv-v2 + pki secrets engines.
#
# Idempotent: re-runs are safe (no-op if mount already exists).
#
# Required env:
#   BAO_ADDR             — http(s)://openbao:8200
#   BAO_TOKEN            — root or admin token (only used at bootstrap; rotate after)
#
# Usage:
#   BAO_ADDR=http://localhost:8200 BAO_TOKEN=... ./00-enable-engines.sh

set -euo pipefail

: "${BAO_ADDR:?BAO_ADDR not set}"
: "${BAO_TOKEN:?BAO_TOKEN not set}"

export BAO_ADDR BAO_TOKEN

enable_if_missing() {
  local engine="$1"
  local path="$2"
  local description="$3"
  if bao secrets list -format=json | jq -e --arg p "${path}/" 'has($p)' >/dev/null; then
    echo "[ok] ${engine} already mounted at ${path}/"
  else
    echo "[+] enabling ${engine} at ${path}/"
    bao secrets enable -path="${path}" -description="${description}" "${engine}"
  fi
}

# F7 — per-workspace cryptoshred keys (D4)
enable_if_missing "transit" "transit" "F7 per-workspace + org cryptoshred keys (D4)"

# Per-service AppRole credentials, MCP API keys, etc.
enable_if_missing "kv-v2" "kv" "Per-service KV secrets (AppRole creds, API keys)"

# PKI for mTLS between F20 ↔ OpenBao and for e-sign certs (sitidos-esign repo).
enable_if_missing "pki" "pki" "Internal mTLS CA + e-sign cert issuance"

# Configure PKI root if not already set (max TTL 10y; root cert never leaves OpenBao).
if ! bao read -format=json pki/cert/ca 2>/dev/null | jq -e '.data.certificate' >/dev/null; then
  echo "[+] generating PKI root"
  bao secrets tune -max-lease-ttl=87600h pki
  bao write -field=certificate pki/root/generate/internal \
    common_name="sitidos-internal-ca" \
    ttl=87600h > /tmp/sitidos-internal-ca.crt
  echo "[ok] PKI root generated; cert at /tmp/sitidos-internal-ca.crt"
fi

echo "[done] engines enabled"
