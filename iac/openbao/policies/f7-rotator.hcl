# F7 rotator — monthly key rotation job. Bumps key versions without destroying.
#
# Job: iac/openbao/jobs/rotate-keys.sh (monthly cron).
#
# Capabilities:
#   - Rotate existing keys (creates new version; old versions retained for snapshot decrypt).
#   - List keys to enumerate workspace-* and org-* for batch rotation.
#   - Update `min_encryption_version` to advance new writes to latest version.
#
# NOT permitted:
#   - Create or delete keys (that's F20).
#   - Read key material (no engine supports that anyway with exportable=false).
#   - Touch `min_decryption_version` (would break historical Iceberg snapshot decrypt).

path "transit/keys" {
  capabilities = ["list"]
}

path "transit/keys/workspace-*/rotate" {
  capabilities = ["update"]
}

path "transit/keys/org-*/rotate" {
  capabilities = ["update"]
}

# Read key metadata (latest_version, min_*_version) for rotation bookkeeping.
path "transit/keys/workspace-*" {
  capabilities = ["read"]
}

path "transit/keys/org-*" {
  capabilities = ["read"]
}

# Advance min_encryption_version after rotate. Do NOT touch min_decryption_version.
path "transit/keys/workspace-*/config" {
  capabilities = ["update"]
}

path "transit/keys/org-*/config" {
  capabilities = ["update"]
}

# Explicit denies.
path "transit/datakey/*" {
  capabilities = ["deny"]
}

path "transit/encrypt/*" {
  capabilities = ["deny"]
}

path "transit/decrypt/*" {
  capabilities = ["deny"]
}
