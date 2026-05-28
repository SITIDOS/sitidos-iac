# Baseline deny policy attached to EVERY service identity in addition to its scoped policy.
#
# Purpose: belt-and-suspenders enforcement of F7 hard prohibitions:
#   - "No service may export key material out of OpenBao."
#   - "No cross-workspace key access; policy enforces."
#   - "No backup of unsealed keys to anywhere outside OpenBao's own backend."
#
# OpenBao policy semantics: explicit `deny` always wins, even against a scoped allow in
# another attached policy. This file guarantees that even a misconfigured per-service policy
# cannot accidentally grant the prohibited operations.

# Never allow exporting key material. `exportable=false` on the key is the primary defense;
# this is the policy-layer fallback.
path "transit/export/*" {
  capabilities = ["deny"]
}

# Never allow generating a plaintext or wrapped data key — banned by F7 hand-off contract
# (transit mode only; no key material leaves OpenBao).
path "transit/datakey/plaintext/*" {
  capabilities = ["deny"]
}

# Backup endpoint returns serialized key material (even if not plaintext). Disallowed
# everywhere; backups go through OpenBao's own backend snapshotting (raft/integrated
# storage), never through the transit backup endpoint.
path "transit/backup/*" {
  capabilities = ["deny"]
}

path "transit/restore/*" {
  capabilities = ["deny"]
}

# Cross-tenant listing — no service may enumerate keys it doesn't own.
# (Rotator gets `list` on `transit/keys` via its own policy; that is the only exception
# and it cannot read/encrypt/decrypt — only rotate.)
path "sys/internal/ui/mounts/transit" {
  capabilities = ["deny"]
}
