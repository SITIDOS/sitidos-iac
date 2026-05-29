# F2 data-reader — decrypt-only against per-workspace transit keys.
#
# Hand-off contract (F7 prompt):
#   const plaintext = await c.decrypt({ workspace_id, ciphertext });
#
# Tenant isolation:
#   - Scoped to `transit/decrypt/workspace-*` and `transit/decrypt/org-*`.
#   - F2 MUST pass the correct workspace_id; decrypt calls are audit-logged.
#   - No encrypt, no rotate, no destroy, no list.
#
# Versioning:
#   - Decrypt automatically uses ciphertext-embedded key version; works across rotations
#     as long as `min_decryption_version` has not advanced past the embedded version.

path "transit/decrypt/workspace-*" {
  capabilities = ["update"]
}

path "transit/decrypt/org-*" {
  capabilities = ["update"]
}

# Explicit denies.
path "transit/keys/*" {
  capabilities = ["deny"]
}

path "transit/datakey/*" {
  capabilities = ["deny"]
}

path "transit/encrypt/*" {
  capabilities = ["deny"]
}
