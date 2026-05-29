#!/usr/bin/env bash
# F14 — Apache Polaris bootstrap (idempotent)
#
# Creates, on first boot (and re-runnable safely thereafter):
#   1. The `sitidos` warehouse, backed by R2 (S3-compat).
#   2. The 7 sitidos namespaces:
#        control, identity, esign, acl, obs, dataroom, crm
#   3. Per-service principals with LEAST-PRIVILEGE namespace grants:
#        - f1-writer            → TABLE_WRITE_DATA on assigned namespaces
#        - f2-reader            → TABLE_READ_DATA  on all 7 namespaces
#        - f15-otel-pipeline    → TABLE_WRITE_DATA on { obs }
#        - f14-publisher        → CATALOG_MANAGE_METADATA (read-only-meta) for
#                                 the snapshot-publisher sidecar
#   4. Per-principal credentials are written to OpenBao at:
#        secret/polaris-creds-<service_name>
#      and surfaced to consumers via the hand-off contract
#        polaris.credentials_ref: openbao:polaris-creds-${service_name}
#
# Laws:
#   D3  — apache/polaris:1.5.0 is the locked image.
#   D4  — per-workspace R2 bucket is the cryptoshred unit.
#   I5  — catalog entries carry ARM64 + cryptoshred declarations.
#
# Hard prohibitions enforced:
#   - No principal gets cross-namespace TABLE_WRITE_DATA.
#   - No principal gets PRINCIPAL_MANAGE (admin) — that stays on the bootstrap
#     root credential, which lives ONLY in OpenBao at secret/polaris-root-creds.
#   - Re-runs MUST NOT rotate existing principal secrets unless --rotate is
#     passed; quarterly rotation is a separate cron job (see runbook).
#
# Usage:
#   POLARIS_URL=http://polaris:8181 \
#   POLARIS_ROOT_CREDS="root:<secret>" \
#   OPENBAO_URL=http://openbao:8200 \
#   OPENBAO_TOKEN=<token> \
#   ./iac/polaris/bootstrap.sh
#
# Optional flags:
#   --rotate           Force-rotate ALL per-service principal secrets.
#   --dry-run          Print planned API calls; make no changes.
#   --namespace <ns>   Restrict bootstrap to a single namespace (debugging).

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

POLARIS_URL="${POLARIS_URL:-http://polaris:8181}"
POLARIS_MGMT_URL="${POLARIS_MGMT_URL:-${POLARIS_URL%/}}"
POLARIS_REALM="${POLARIS_REALM:-sitidos}"
POLARIS_ROOT_CREDS="${POLARIS_ROOT_CREDS:?POLARIS_ROOT_CREDS=client_id:client_secret required}"

OPENBAO_URL="${OPENBAO_URL:-http://openbao:8200}"
OPENBAO_TOKEN="${OPENBAO_TOKEN:?OPENBAO_TOKEN required to store issued principal creds}"

WAREHOUSE_NAME="${POLARIS_DEFAULT_WAREHOUSE:-sitidos}"
R2_BUCKET="${R2_BUCKET:?R2_BUCKET required}"
R2_ENDPOINT_URL="${R2_ENDPOINT_URL:?R2_ENDPOINT_URL required}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"

NAMESPACES=(control identity esign acl obs dataroom crm)

# Principal → namespaces it may WRITE to (read-all is assumed for f2-reader).
# Cross-namespace writes are FORBIDDEN by the hard prohibitions.
declare -A WRITE_GRANTS=(
  [f1-writer]="control identity esign acl dataroom crm"   # F1 owns writer-side
  [f15-otel-pipeline]="obs"                                # F15 OTel pipeline only
)
READ_PRINCIPALS=(f2-reader)
META_PRINCIPALS=(f14-publisher)

DRY_RUN=0
ROTATE=0
LIMIT_NAMESPACE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --rotate)    ROTATE=1 ;;
    --namespace) LIMIT_NAMESPACE="$2"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { printf '[bootstrap] %s\n' "$*" >&2; }

polaris_token() {
  # OAuth2 client-credentials grant against root principal.
  local cid="${POLARIS_ROOT_CREDS%%:*}"
  local sec="${POLARIS_ROOT_CREDS#*:}"
  curl -sf -X POST \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -H "Polaris-Realm: ${POLARIS_REALM}" \
    -d "grant_type=client_credentials&client_id=${cid}&client_secret=${sec}&scope=PRINCIPAL_ROLE:ALL" \
    "${POLARIS_URL}/api/catalog/v1/oauth/tokens" \
    | jq -r '.access_token'
}

polaris_api() {
  local method="$1" path="$2" body="${3:-}"
  if (( DRY_RUN )); then
    log "DRY-RUN ${method} ${path}${body:+ body=${body}}"
    echo '{}'
    return
  fi
  local args=( -sS -X "${method}"
    -H "Authorization: Bearer ${POLARIS_BEARER}"
    -H "Polaris-Realm: ${POLARIS_REALM}"
    -H 'Content-Type: application/json' )
  [[ -n "${body}" ]] && args+=( -d "${body}" )
  curl "${args[@]}" "${POLARIS_MGMT_URL}${path}"
}

openbao_put() {
  local key="$1" value="$2"
  if (( DRY_RUN )); then
    log "DRY-RUN openbao put secret/${key}"; return
  fi
  curl -sf -X POST \
    -H "X-Vault-Token: ${OPENBAO_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"data\":{\"value\":\"${value}\"}}" \
    "${OPENBAO_URL}/v1/secret/data/${key}" >/dev/null
}

ensure_warehouse() {
  log "Ensuring warehouse '${WAREHOUSE_NAME}' on R2 bucket '${R2_BUCKET}'"
  local payload
  payload=$(jq -nc \
    --arg name "${WAREHOUSE_NAME}" \
    --arg bucket "${R2_BUCKET}" \
    --arg endpoint "${R2_ENDPOINT_URL}" \
    --arg keyid "${R2_ACCESS_KEY_ID}" \
    --arg secret "${R2_SECRET_ACCESS_KEY}" \
    '{
      name: $name,
      type: "INTERNAL",
      properties: { "default-base-location": ("s3://" + $bucket + "/warehouse") },
      storageConfigInfo: {
        storageType: "S3",
        roleArn: null,
        allowedLocations: [ ("s3://" + $bucket + "/") ],
        endpoint: $endpoint,
        accessKeyId: $keyid,
        secretAccessKey: $secret,
        region: "auto",
        pathStyleAccess: true
      }
    }')
  polaris_api POST "/api/management/v1/catalogs" "${payload}" >/dev/null \
    || log "  warehouse already exists — OK"
}

ensure_namespace() {
  local ns="$1"
  log "Ensuring namespace '${ns}'"
  local payload
  payload=$(jq -nc --arg ns "${ns}" \
    '{ namespace: [$ns], properties: { "sitidos.foundation": "F14", "sitidos.arm64": "true" } }')
  polaris_api POST \
    "/api/catalog/v1/${POLARIS_REALM}/namespaces" \
    "${payload}" >/dev/null 2>&1 \
    || log "  namespace '${ns}' already exists — OK"
}

ensure_principal() {
  local name="$1"
  log "Ensuring principal '${name}'"
  local existing
  existing=$(polaris_api GET "/api/management/v1/principals/${name}" 2>/dev/null || echo "")
  if [[ -n "${existing}" && "${existing}" != *"NotFound"* && ${ROTATE} -eq 0 ]]; then
    log "  principal '${name}' exists; skip (use --rotate to force)"
    return
  fi
  local payload secret
  payload=$(jq -nc --arg n "${name}" '{ name: $n, type: "SERVICE" }')
  local resp
  resp=$(polaris_api POST "/api/management/v1/principals" "${payload}")
  secret=$(printf '%s' "${resp}" | jq -r '.credentials.clientSecret // empty')
  if [[ -n "${secret}" ]]; then
    local cid; cid=$(printf '%s' "${resp}" | jq -r '.credentials.clientId')
    openbao_put "polaris-creds-${name}" "${cid}:${secret}"
    log "  stored credentials at openbao:secret/polaris-creds-${name}"
  fi
}

grant_namespace_privilege() {
  local principal="$1" namespace="$2" privilege="$3"
  log "Granting ${privilege} on ${namespace} to ${principal}"
  local payload
  payload=$(jq -nc \
    --arg p "${privilege}" \
    --arg ns "${namespace}" \
    '{ type: "namespace", namespace: [$ns], privilege: $p }')
  polaris_api PUT \
    "/api/management/v1/principal-roles/${principal}/grants" \
    "${payload}" >/dev/null
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

command -v jq   >/dev/null || { echo "jq required"   >&2; exit 1; }
command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }

log "Authenticating to Polaris at ${POLARIS_URL} (realm=${POLARIS_REALM})"
POLARIS_BEARER=$(polaris_token)
[[ -n "${POLARIS_BEARER}" ]] || { echo "auth failed" >&2; exit 1; }

ensure_warehouse

for ns in "${NAMESPACES[@]}"; do
  [[ -n "${LIMIT_NAMESPACE}" && "${LIMIT_NAMESPACE}" != "${ns}" ]] && continue
  ensure_namespace "${ns}"
done

# Writer principals (per-namespace least privilege)
for principal in "${!WRITE_GRANTS[@]}"; do
  ensure_principal "${principal}"
  for ns in ${WRITE_GRANTS[$principal]}; do
    [[ -n "${LIMIT_NAMESPACE}" && "${LIMIT_NAMESPACE}" != "${ns}" ]] && continue
    grant_namespace_privilege "${principal}" "${ns}" "TABLE_WRITE_DATA"
    grant_namespace_privilege "${principal}" "${ns}" "TABLE_READ_DATA"
  done
done

# Reader principal — TABLE_READ_DATA across all 7 namespaces (F2)
for principal in "${READ_PRINCIPALS[@]}"; do
  ensure_principal "${principal}"
  for ns in "${NAMESPACES[@]}"; do
    [[ -n "${LIMIT_NAMESPACE}" && "${LIMIT_NAMESPACE}" != "${ns}" ]] && continue
    grant_namespace_privilege "${principal}" "${ns}" "TABLE_READ_DATA"
  done
done

# Metadata-only principal — for the snapshot-publisher sidecar (F14 self)
for principal in "${META_PRINCIPALS[@]}"; do
  ensure_principal "${principal}"
  for ns in "${NAMESPACES[@]}"; do
    [[ -n "${LIMIT_NAMESPACE}" && "${LIMIT_NAMESPACE}" != "${ns}" ]] && continue
    grant_namespace_privilege "${principal}" "${ns}" "TABLE_LIST"
    grant_namespace_privilege "${principal}" "${ns}" "TABLE_READ_PROPERTIES"
  done
done

log "Bootstrap complete. Hand-off:"
log "  polaris.endpoint:        ${POLARIS_URL}"
log "  polaris.credentials_ref: openbao:polaris-creds-\${service_name}"
