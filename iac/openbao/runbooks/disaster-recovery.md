# OpenBao Disaster Recovery Runbook (F7)

Owner: **F7**. Read end-to-end before touching production OpenBao. Every step is deliberate;
mistakes here are cryptographically irreversible (which is also the entire point of D4).

---

## 0. Threat model

The two things this runbook must protect against:

1. **Loss of the OpenBao instance** (host dies, storage corruption, accidental `docker
   compose down -v`). Recovery = restore last sealed snapshot, then unseal.
2. **A workspace key needs to be *proven* unrecoverable** after `destroyKey` (compliance / GDPR
   right-to-erasure attestation). Cryptoshred verification = §3.

This runbook does NOT cover key-material exfiltration: by design (D4 + F7 hard prohibitions),
key material never leaves OpenBao. There is no "lost key material" scenario; there is only
"sealed snapshot lost" (recoverable iff Shamir shares are still distributed) or "key destroyed"
(intentionally irrecoverable).

---

## 1. Backup strategy

OpenBao runs in **integrated storage (raft)** mode (see `compose/openbao.yaml`). Backups are
**sealed raft snapshots** — they contain the encrypted-at-rest store; without the unseal keys
+ master key they are useless.

| Layer | Frequency | Destination | Encrypted at rest |
|---|---|---|---|
| Raft snapshot (sealed) | hourly | local `stack/data/openbao-snapshots/` | yes (OpenBao's own seal) |
| Raft snapshot (sealed) | daily   | R2 bucket `sitidos-openbao-snapshots` | yes + R2 SSE |
| Shamir unseal shares   | n/a (founder distributes once at init) | 5 separate physical locations, threshold 3 | n/a |

Take a snapshot:

```bash
# From inside the openbao container or with BAO_ADDR pointing to it:
bao operator raft snapshot save /openbao/data/snapshots/openbao-$(date +%Y%m%d-%H%M).snap
```

The included `jobs/rotate-keys.sh` is independent of snapshots; rotating keys does NOT change
the snapshot cadence. Always take a snapshot **immediately before** any rotation run in
production, so a rollback target exists if rotation triggers a downstream bug.

---

## 2. Restore from sealed backup

Assumes: a new OpenBao node is up (e.g. fresh container on the Oracle ARM host) with empty
data dir, in sealed state, listening on `BAO_ADDR`.

```bash
# 1. Initialize the new node (this generates NEW unseal keys — do NOT do this if you intend
#    to restore the previous state without re-initializing).
#
#    For true DR (restoring the SAME cluster identity), copy the previous raft data dir
#    contents and skip init. Then unseal with the EXISTING Shamir shares.
#
# 2. Unseal with 3 of 5 Shamir shares.
bao operator unseal <share-1>
bao operator unseal <share-2>
bao operator unseal <share-3>

# 3. Login with the root token (or an admin token if root has been revoked, which is
#    recommended post-bootstrap).
bao login <token>

# 4. Restore the snapshot. -force is required because the destination already has state
#    (the raft metadata from initialization).
bao operator raft snapshot restore -force /path/to/openbao-YYYYMMDD-HHMM.snap

# 5. Verify all transit keys are back.
bao list transit/keys | grep -E '^(workspace-|org-)' | wc -l

# 6. Verify a sample decrypt round-trip with a known plaintext.
bao write transit/encrypt/workspace-<known-id> plaintext="$(echo -n test | base64)"
bao write transit/decrypt/workspace-<known-id> ciphertext=<ciphertext-from-above>
```

If decrypt returns the original plaintext, the restore is complete and the cluster is
functionally identical to the pre-failure state.

---

## 3. Verifying a destroyed key is truly unrecoverable (cryptoshred attestation)

After `destroyKey({ workspace_id })` succeeds, the auditor / compliance officer needs evidence
that the key cannot come back. Run this checklist:

### 3.1 Confirm the key is gone from the live store

```bash
# Should return a 404 / "encryption key not found".
bao read transit/keys/workspace-<workspace_id> 2>&1 | grep -q "not found" \
  && echo "[ok] key absent from live transit store" \
  || echo "[FAIL] key still present — destroyKey did not complete"
```

### 3.2 Confirm no recoverable copy exists in any snapshot newer than the destroy event

The cryptoshred event in `obs.events` has a `ts` field. **All raft snapshots taken AFTER that
timestamp must also have the key absent.** Snapshots taken BEFORE that timestamp *do* contain
the key (that's expected — snapshots are point-in-time) and form a different attestation
problem (see §3.3).

```bash
# For each post-destroy snapshot, restore into a throwaway OpenBao instance and verify
# the key is absent. Automated by scripts/dr-attest-destroy.sh (not yet shipped; see backlog).
```

### 3.3 Snapshots taken BEFORE the destroy event

Two cases:

- **Hourly local snapshots** (`stack/data/openbao-snapshots/`): retention policy is 7 days.
  After 7 days, no snapshot exists that contains the key. Document the destroy timestamp +
  7 days in the compliance log as the "full cryptoshred" date.
- **Daily R2 snapshots**: retention policy is **30 days** with R2 Object Lock in compliance
  mode. After 30 days, no snapshot exists that contains the key. Same documentation.

For GDPR Article 17 requests with shorter SLAs (e.g. 30-day delete deadline that requires
immediate erasure), the snapshot rotation cadence is acceptable because the data in old
snapshots is **encrypted with the destroyed key** — even though the key bytes exist in the
old snapshot, the *data* the user wants erased is in Iceberg/R2 and is now ciphertext only.
The legal posture is: the destroyed-key snapshot fragment is itself encrypted with the
OpenBao master key (seal-wrap), which is never exfiltrated, so the user's plaintext is
already cryptographically unreachable from the moment `destroyKey` returned.

### 3.4 Verify the cryptoshred event was emitted

```bash
# Query obs.events Iceberg table for the cryptoshred record.
# (Equivalent SQL — actual query goes through F2 reader / F16 UI.)
#
#   SELECT * FROM obs.events
#   WHERE event_type = 'cryptoshred.destroyed'
#     AND attributes['workspace_id'] = '<workspace_id>'
#   ORDER BY ts DESC LIMIT 1;
#
# Expect: exactly one row, ts within the past few minutes of the destroyKey call,
# attributes.requesting_service = 'f20-org-service', attributes.mtls_subject set.
```

A missing event is a bug — the SDK is required to emit it transactionally with the
`DELETE transit/keys/...` call.

---

## 4. Founder-provisioned secrets (BLOCKED until provided)

The dev compose stack uses a hardcoded dev root token. Production cutover requires founder
provisioning of:

| Secret | Where it goes | Notes |
|---|---|---|
| `OPENBAO_ROOT_TOKEN` | Used ONCE at bootstrap; rotated immediately | Generated by `bao operator init` |
| `OPENBAO_UNSEAL_SHARES` (5 shares, threshold 3) | Founder distributes physically | NEVER store >2 shares in one location |
| `OPENBAO_R2_SNAPSHOT_BUCKET` | Env on snapshot cron | R2 bucket name + credentials |
| `OPENBAO_F20_MTLS_CA` + `OPENBAO_F20_MTLS_CERT` | PKI issues after bootstrap | F20 service auth |
| `OPENBAO_AUTO_UNSEAL_KMS` (optional) | Cloudflare KMS or similar | If present, replaces Shamir for routine restarts; recovery keys still issued |

All are flagged in the F7 PR body for founder provisioning before prod cutover.

---

## 5. Emergency: suspected key-material leak

If there is reason to believe a transit key has somehow been exfiltrated (which should be
impossible with `exportable=false`, `allow_plaintext_backup=false`, and the deny-list policy
— but assume the worst):

1. **Rotate the key immediately** (`transit/keys/<name>/rotate`).
2. **Advance `min_encryption_version`** to the new version (so new writes use the new key).
3. **DO NOT advance `min_decryption_version`** unless you have re-encrypted all historical
   Iceberg snapshots with the new key version (use `transit/rewrap/<name>` per record).
4. **Audit the OpenBao audit log** (`audit.log` in the snapshot) for any `transit/keys/*/export`
   or `transit/datakey/plaintext/*` calls — these are denied by `deny-list.hcl` but the audit
   log proves it.
5. **Open a security incident** per the (forthcoming) Sitidos IR runbook.

---

## 6. Backlog (not in this PR)

- `scripts/dr-attest-destroy.sh` — automate §3.1 + §3.2 against a snapshot dir.
- Cloudflare KMS auto-unseal terraform (deferred until Oracle ARM cutover, Phase 3).
- R2 snapshot uploader cron (deferred until F11 ships the R2 bucket terraform).
