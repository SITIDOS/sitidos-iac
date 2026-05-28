# F20 org-service — create + destroy workspace keys (CRYPTOSHRED authority).
#
# Hand-off contract (F7 prompt):
#   await c.destroyKey({ workspace_id });   // CRYPTOSHRED — irreversible
#
# Authentication:
#   - mTLS-gated (NOT AppRole). The client SDK enforces caller identity via mTLS to OpenBao.
#   - This policy is bound to the F20 mTLS cert auth role only.
#
# Lifecycle ops:
#   - createKey: POST transit/keys/workspace-${id}  (sets `deletion_allowed=true`,
#     `exportable=false`, `allow_plaintext_backup=false`, `type=aes256-gcm96`).
#   - destroyKey: DELETE transit/keys/workspace-${id}?force=true (irreversible; emits
#     cryptoshred event to obs.events via the SDK).
#
# F20 does NOT have encrypt/decrypt capability. Keeping lifecycle authority separate from
# data-plane authority is the minimum separation-of-duties guarantee.

# Create + update key configuration (e.g., set deletion_allowed before destroy).
path "transit/keys/workspace-*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "transit/keys/org-*" {
  capabilities = ["create", "read", "update", "delete"]
}

# Required to enable deletion before DELETE (transit refuses delete unless
# deletion_allowed=true on the key config).
path "transit/keys/workspace-*/config" {
  capabilities = ["update"]
}

path "transit/keys/org-*/config" {
  capabilities = ["update"]
}

# Explicit denies — F20 must never read key material or perform data-plane ops.
path "transit/datakey/*" {
  capabilities = ["deny"]
}

path "transit/encrypt/*" {
  capabilities = ["deny"]
}

path "transit/decrypt/*" {
  capabilities = ["deny"]
}

path "transit/export/*" {
  capabilities = ["deny"]
}
