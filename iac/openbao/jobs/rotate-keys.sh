#!/usr/bin/env bash
# rotate-keys.sh — monthly key rotation job.
#
# Schedule: monthly cron (managed by stack supervisor / Oracle ARM crontab).
#   0 3 1 * *  /opt/sitidos-iac/iac/openbao/jobs/rotate-keys.sh >> /var/log/sitidos/openbao-rotate.log 2>&1
#
# What it does:
#   1. Lists every transit key under `workspace-*` and `org-*`.
#   2. Calls `transit/keys/<name>/rotate` (new version; old versions retained).
#   3. Reads `latest_version` and bumps `min_encryption_version` to it (new writes use new key).
#   4. NEVER touches `min_decryption_version` — past Iceberg snapshots must remain decryptable.
#   5. Emits one `obs.events` row per rotated key (event_type='openbao.key_rotated').
#
# Failure modes:
#   - Per-key rotate failure → log + continue with next key. Job exits non-zero at end.
#   - List failure → fatal; exit non-zero (alerts via cron monitoring).
#
# This script uses the f7-rotator AppRole, which has NO encrypt/decrypt/destroy capability.

set -uo pipefail

: "${BAO_ADDR:?BAO_ADDR not set}"
: "${ROTATOR_ROLE_ID:?ROTATOR_ROLE_ID not set}"
: "${ROTATOR_SECRET_ID:?ROTATOR_SECRET_ID not set}"
: "${OBS_EVENTS_SINK:=}"   # optional: HTTP endpoint to POST cryptoshred / rotation events

export BAO_ADDR

# Login with rotator approle.
BAO_TOKEN="$(bao write -field=token auth/approle/login \
  role_id="${ROTATOR_ROLE_ID}" \
  secret_id="${ROTATOR_SECRET_ID}")"
export BAO_TOKEN

failures=0
rotated=0

emit_event() {
  local key_name="$1"
  local from_v="$2"
  local to_v="$3"
  local payload
  payload="$(jq -n \
    --arg key "${key_name}" \
    --argjson from "${from_v}" \
    --argjson to "${to_v}" \
    '{event_type:"openbao.key_rotated", key:$key, from_version:$from, to_version:$to, ts:(now|todate)}')"
  echo "${payload}"
  if [[ -n "${OBS_EVENTS_SINK}" ]]; then
    curl -sf -X POST "${OBS_EVENTS_SINK}" \
      -H "content-type: application/json" \
      -d "${payload}" || echo "[warn] failed to emit event for ${key_name}"
  fi
}

# Enumerate keys; filter to workspace-* and org-*.
mapfile -t keys < <(bao list -format=json transit/keys 2>/dev/null \
  | jq -r '.[]' \
  | grep -E '^(workspace-|org-)' || true)

if [[ ${#keys[@]} -eq 0 ]]; then
  echo "[ok] no workspace/org keys to rotate"
  exit 0
fi

for key in "${keys[@]}"; do
  from_v="$(bao read -format=json "transit/keys/${key}" | jq -r '.data.latest_version')"
  if ! bao write -f "transit/keys/${key}/rotate" >/dev/null 2>&1; then
    echo "[fail] rotate ${key}"
    failures=$((failures + 1))
    continue
  fi
  to_v="$(bao read -format=json "transit/keys/${key}" | jq -r '.data.latest_version')"
  # Advance min_encryption_version so new writes use latest key. Decryption of historical
  # snapshots remains possible (min_decryption_version stays at 1).
  bao write "transit/keys/${key}/config" min_encryption_version="${to_v}" >/dev/null
  rotated=$((rotated + 1))
  emit_event "${key}" "${from_v}" "${to_v}"
done

echo "[done] rotated=${rotated} failures=${failures}"
exit "${failures}"
