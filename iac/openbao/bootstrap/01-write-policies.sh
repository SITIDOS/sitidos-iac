#!/usr/bin/env bash
# 01-write-policies.sh — apply all policies/*.hcl to the OpenBao server.
#
# Idempotent: `bao policy write` is an upsert.

set -euo pipefail

: "${BAO_ADDR:?BAO_ADDR not set}"
: "${BAO_TOKEN:?BAO_TOKEN not set}"
export BAO_ADDR BAO_TOKEN

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICIES_DIR="${SCRIPT_DIR}/../policies"

for policy_file in "${POLICIES_DIR}"/*.hcl; do
  policy_name="$(basename "${policy_file}" .hcl)"
  echo "[+] writing policy: ${policy_name}"
  bao policy write "${policy_name}" "${policy_file}"
done

echo "[done] policies applied:"
bao policy list | grep -E '^(f1-|f2-|f7-|f20-|deny-)' || true
