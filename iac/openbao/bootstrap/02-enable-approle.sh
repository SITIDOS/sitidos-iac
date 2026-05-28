#!/usr/bin/env bash
# 02-enable-approle.sh — enable AppRole auth method and create roles for F1, F2, F7-rotator.
#
# F20 uses mTLS (cert auth) instead — wired by a separate script after PKI root is generated.
#
# Outputs role_id + secret_id for each service to stdout. In production these are written
# directly into the per-service KV mount (kv/data/services/<name>/openbao_creds) so the
# service can self-fetch via init-container.

set -euo pipefail

: "${BAO_ADDR:?BAO_ADDR not set}"
: "${BAO_TOKEN:?BAO_TOKEN not set}"
export BAO_ADDR BAO_TOKEN

# Enable approle if missing.
if ! bao auth list -format=json | jq -e '."approle/"' >/dev/null; then
  echo "[+] enabling approle auth"
  bao auth enable approle
else
  echo "[ok] approle already enabled"
fi

create_role() {
  local role="$1"
  local policies="$2"
  echo "[+] role: ${role} (policies: ${policies})"
  bao write "auth/approle/role/${role}" \
    token_policies="${policies}" \
    token_ttl=1h \
    token_max_ttl=4h \
    secret_id_ttl=0 \
    secret_id_num_uses=0
  local role_id secret_id
  role_id="$(bao read -field=role_id "auth/approle/role/${role}/role-id")"
  secret_id="$(bao write -force -field=secret_id "auth/approle/role/${role}/secret-id")"
  echo "  role_id=${role_id}"
  echo "  secret_id=${secret_id}"
  # Persist into KV so services can fetch via init.
  bao kv put "kv/services/${role}/openbao_creds" \
    role_id="${role_id}" \
    secret_id="${secret_id}" >/dev/null
}

create_role "f1-data-writer"  "f1-data-writer,deny-list"
create_role "f2-data-reader"  "f2-data-reader,deny-list"
create_role "f7-rotator"      "f7-rotator,deny-list"

echo "[done] approle roles created; creds persisted to kv/services/<role>/openbao_creds"
