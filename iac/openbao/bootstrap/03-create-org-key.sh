#!/usr/bin/env bash
# 03-create-org-key.sh — create the org-level transit key for cryptoshred.key_binding='org' rows.
#
# Per D4: most Iceberg tables use cryptoshred_coverage='workspace' (per-workspace key).
# A small set of org-scoped tables (e.g. control/orgs, control/auth_provider_role_mappings)
# use cryptoshred_coverage='org' and share a single org-level key.
#
# Workspace keys are created on-demand by F20 via the SDK; this script only creates the org key.

set -euo pipefail

: "${BAO_ADDR:?BAO_ADDR not set}"
: "${BAO_TOKEN:?BAO_TOKEN not set}"
: "${ORG_ID:?ORG_ID not set (e.g. sitidos for the master org)}"
export BAO_ADDR BAO_TOKEN

KEY_NAME="org-${ORG_ID}"

if bao read -format=json "transit/keys/${KEY_NAME}" 2>/dev/null | jq -e '.data.name' >/dev/null; then
  echo "[ok] transit key ${KEY_NAME} already exists"
  exit 0
fi

echo "[+] creating transit key: ${KEY_NAME}"
bao write -f "transit/keys/${KEY_NAME}" \
  type=aes256-gcm96 \
  exportable=false \
  allow_plaintext_backup=false \
  deletion_allowed=false  # F20 flips this to true immediately before destroyKey

echo "[done] org key ${KEY_NAME} created"
