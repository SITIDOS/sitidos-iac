# F14 Runbook — Polaris catalog recovery from snapshot

**Foundation:** F14 — Polaris Catalog
**Image (locked, D3):** `apache/polaris:1.5.0` (ARM64 PASS per
[`foundation-validation-2026-05-28.md`](../../../docs/agents/foundation-validation-2026-05-28.md))
**Backend:** Cloudflare R2 (S3-compatible) — bucket `sitidos-catalog`
**Owners:** F14 (this runbook), F3 (compose supervisor), F2 (OpenBao)

> **Persistence model (read first).** Polaris 1.5.0's only durable `relational-jdbc`
> store is build-time-fixed to PostgreSQL in the locked image, which D1 bans. Per the
> metastore decision (option B, "rebuild from R2"), Polaris runs **`in-memory`** and
> **R2/Iceberg is the source of truth**. Consequence: the catalog is **empty after every
> restart** and is reconstructed by walking R2 — there is NO EclipseLink/H2 store and
> nothing is auto-rebuilt. The reconstruction is a single command:
> `python3 iac/polaris/catalog-rebuild.py` (discovers each table's latest
> `*.metadata.json` in R2 and `register-table`s it). This makes restarts cheap and
> fully recoverable with zero SQL.

This runbook covers four scenarios:

1. **Container loss / any restart** — Polaris container restarts (in-memory catalog lost) but R2 + OpenBao intact.
2. **Persistence loss** — historical EclipseLink/H2 scenario; N/A under in-memory (kept for the relational-jdbc-on-Postgres future). Same fix: rebuild from R2.
3. **R2 object damage** — single Iceberg table cannot be loaded; underlying R2 objects intact at an older snapshot.
4. **Quarterly credential rotation** — non-emergency, scheduled.

> **Hard prohibitions (do NOT violate during recovery):**
> - No catalog image other than `apache/polaris:1.5.0`.
> - No backend other than R2.
> - No direct mutation of R2 objects bypassing the Polaris API — even during recovery, all snapshot mutations go through Polaris.
> - No principal granted cross-namespace `TABLE_WRITE_DATA`.

---

## 0. Preconditions for every scenario

```bash
# Identify which host runs the catalog (dev: macbook; prod: Oracle Ampere).
docker ps --filter name=sitidos-polaris --format '{{.Status}}'

# Confirm OpenBao reachable and unsealed.
curl -sf "${OPENBAO_URL:-http://openbao:8200}/v1/sys/health" | jq .sealed
# Expect: false

# Confirm R2 reachable via S3 client.
aws s3 ls "s3://${R2_BUCKET:-sitidos-catalog}/" \
  --endpoint-url "${R2_ENDPOINT_URL}" --region auto
```

If any precondition fails, fix that first — Polaris recovery without OpenBao or R2 is meaningless.

---

## 1. Container loss / any restart (R2 + OpenBao intact)

This is the common case. The in-memory catalog is empty after boot; reconstruct it from
R2 with `catalog-rebuild.py`. (R2 holds every table's `metadata.json` — the source of truth.)

```bash
cd $(git rev-parse --show-toplevel)
docker compose -f compose/polaris.yaml pull polaris        # idempotent
docker compose -f compose/polaris.yaml up -d polaris

# Wait for health
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf http://localhost:8182/q/health/ready && break
  sleep 5
done

# Reconstruct the catalog from R2 (creates the catalog if absent, re-registers every
# table from its latest metadata.json). Needs R2_* + POLARIS_ROOT_CREDS in the env.
python3 iac/polaris/catalog-rebuild.py
# Expect: "✓ registered <ns>.<table>" per table, then "DONE: N registered ...".

# Verify the 7 namespaces are visible.
TOKEN=$(curl -sf -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Polaris-Realm: sitidos' \
  -d "grant_type=client_credentials&client_id=${ROOT_ID}&client_secret=${ROOT_SECRET}&scope=PRINCIPAL_ROLE:ALL" \
  http://localhost:8181/api/catalog/v1/oauth/tokens | jq -r .access_token)

curl -sf -H "Authorization: Bearer ${TOKEN}" -H 'Polaris-Realm: sitidos' \
  http://localhost:8181/api/catalog/v1/sitidos/namespaces | jq .
# Expect: { "namespaces": [["control"],["identity"],["esign"],["acl"],["obs"],["dataroom"],["crm"]] }
```

Total expected RTO: **< 2 minutes**.

---

## 2. Persistence loss (EclipseLink corrupt; R2 intact)

Polaris keeps its catalog mappings in the EclipseLink store under `/var/lib/polaris`. If that volume is corrupted, re-bootstrap from the R2 warehouse manifest.

```bash
# 1. Stop the catalog
docker compose -f compose/polaris.yaml stop polaris

# 2. Move (do NOT delete) the corrupt store for post-mortem
sudo mv stack/data/polaris stack/data/polaris.corrupt-$(date +%Y%m%d%H%M)

# 3. Boot a fresh empty Polaris
docker compose -f compose/polaris.yaml up -d polaris
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf http://localhost:8182/q/health/ready && break; sleep 5
done

# 4. Re-run bootstrap WITHOUT --rotate so existing OpenBao-stored principal
#    credentials remain valid. Bootstrap is idempotent and will:
#      - re-register the R2 warehouse,
#      - re-create the 7 namespaces,
#      - re-register the 4 service principals using the EXISTING client_ids
#        already stored at openbao:secret/polaris-creds-*.
export POLARIS_URL=http://localhost:8181
export POLARIS_ROOT_CREDS=$(curl -sf -H "X-Vault-Token: ${OPENBAO_TOKEN}" \
  ${OPENBAO_URL}/v1/secret/data/polaris-root-creds | jq -r .data.data.value)
export OPENBAO_URL=http://localhost:8200
export OPENBAO_TOKEN=...   # from operator session
export R2_BUCKET=sitidos-catalog
export R2_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...

bash iac/polaris/bootstrap.sh

# 5. Re-register every Iceberg table from R2. catalog-rebuild.py walks R2
#    directly (no inventory.json needed — R2 IS the inventory), picks each
#    table's newest metadata.json, ensures namespaces, and register-tables it.
python3 iac/polaris/catalog-rebuild.py
```

Total expected RTO: **15–30 minutes** depending on table count.

---

## 3. R2 object damage — roll a single table back

If a snapshot is bad (e.g., F1 wrote schema-broken data) BUT older snapshots remain in R2:

```bash
# 1. Find the prior good snapshot id.
TOKEN=$(... per §1 ...)
curl -sf -H "Authorization: Bearer ${TOKEN}" -H 'Polaris-Realm: sitidos' \
  http://localhost:8181/api/catalog/v1/sitidos/namespaces/${NS}/tables/${TABLE} \
  | jq '.metadata.snapshots[] | {snapshot_id, "parent-snapshot-id", "timestamp-ms"}'

# 2. Roll the table's current-snapshot-id back via the Polaris commit API.
#    DO NOT delete the bad snapshot — keep it for audit (D11 spirit).
curl -sf -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Polaris-Realm: sitidos' \
  -H 'Content-Type: application/json' \
  -d '{
    "updates": [
      { "action": "set-snapshot-ref",
        "ref-name": "main",
        "type": "branch",
        "snapshot-id": <GOOD_SNAPSHOT_ID> }
    ],
    "requirements": [
      { "type": "assert-ref-snapshot-id",
        "ref": "main",
        "snapshot-id": <CURRENT_BAD_SNAPSHOT_ID> }
    ]
  }' \
  http://localhost:8181/api/catalog/v1/sitidos/namespaces/${NS}/tables/${TABLE}

# 3. Snapshot-publisher sidecar will detect the change and emit on
#    `polaris.snapshots`. F2 cache + F17 ISR will invalidate automatically.
```

---

## 4. Quarterly credential rotation (scheduled)

Per `iac/polaris/r2-backend.json` → `credentials.rotation_policy`.

```bash
# Rotate ALL per-service Polaris principal secrets.
# OpenBao stores both old and new for 24h to allow consumers to roll.
bash iac/polaris/bootstrap.sh --rotate

# Then rotate the R2 credential at Cloudflare dashboard:
#   1. Issue new R2 API token (scoped to sitidos-catalog bucket, R/W).
#   2. Update GitHub org secrets R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.
#   3. Update OpenBao secret/r2/sitidos-catalog.
#   4. Restart polaris service:
#        docker compose -f compose/polaris.yaml up -d --force-recreate polaris
#   5. After 24h soak, revoke the old R2 token at Cloudflare.
```

---

## 5. Hand-off contract verification (smoke test after any recovery)

```yaml
polaris:
  endpoint: http://polaris:8181
  credentials_ref: openbao:polaris-creds-${service_name}
```

```bash
# Round-trip a known reader principal end-to-end.
CREDS=$(curl -sf -H "X-Vault-Token: ${OPENBAO_TOKEN}" \
  ${OPENBAO_URL}/v1/secret/data/polaris-creds-f2-reader | jq -r .data.data.value)
CID=${CREDS%%:*}; SEC=${CREDS#*:}

curl -sf -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Polaris-Realm: sitidos' \
  -d "grant_type=client_credentials&client_id=${CID}&client_secret=${SEC}&scope=PRINCIPAL_ROLE:ALL" \
  http://localhost:8181/api/catalog/v1/oauth/tokens \
  | jq -r .access_token
# Expect: a non-empty bearer token.
```

If this returns a token, the catalog is operational and the hand-off contract holds.

---

## Appendix — file map

| Path | Purpose |
|---|---|
| `compose/polaris.yaml` | Standalone compose overlay for Polaris + publisher sidecar. |
| `iac/polaris/bootstrap.sh` | Idempotent first-boot + re-bootstrap script. |
| `iac/polaris/catalog-rebuild.py` | Reconstruct the in-memory catalog from R2 (run after every restart). |
| `iac/polaris/r2-backend.json` | Declarative R2 backend + IAM model. |
| `iac/polaris/snapshot-publisher/` | Sidecar source (Dockerfile + `publisher.py`). |
| `iac/polaris/runbooks/catalog-recovery.md` | This file. |
| `stack/compose/sitidos.yml` | Full backplane stack; mirrors `compose/polaris.yaml`'s polaris service. |
| `stack/config/polaris/` | Bind-mounted Polaris config (currently placeholder). |
