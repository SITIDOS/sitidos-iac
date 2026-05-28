# F1 data-writer — encrypt-only against per-workspace transit keys.
#
# Hand-off contract (F7 prompt):
#   const ciphertext = await c.encrypt({ workspace_id, plaintext });
#
# Tenant isolation:
#   - Scoped to `transit/encrypt/workspace-*` and `transit/encrypt/org-*`.
#   - F1 MUST pass the correct workspace_id; encrypt calls are audit-logged.
#   - No list, no read of key metadata, no rotate, no destroy.
#   - No access to any other engine mount.
#
# Hard prohibition enforced:
#   - No `transit/keys/*` read/list/update (key material never leaves OpenBao).
#   - No `transit/datakey/*` (would return plaintext data key — banned).

path "transit/encrypt/workspace-*" {
  capabilities = ["update"]
}

path "transit/encrypt/org-*" {
  capabilities = ["update"]
}

# Allow rewrap for transparent key-version migration on read-modify-write.
path "transit/rewrap/workspace-*" {
  capabilities = ["update"]
}

path "transit/rewrap/org-*" {
  capabilities = ["update"]
}

# Explicit denies — defense-in-depth even though absence == deny by default.
path "transit/keys/*" {
  capabilities = ["deny"]
}

path "transit/datakey/*" {
  capabilities = ["deny"]
}

path "transit/decrypt/*" {
  capabilities = ["deny"]
}
