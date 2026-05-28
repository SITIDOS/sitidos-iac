# OpenBao production server HCL — F7-owned.
#
# Copied at deploy time to stack/config/openbao/openbao.hcl and mounted into the container
# at /openbao/config/openbao.hcl by compose/openbao.yaml.
#
# Storage:     integrated raft (single node now; expand to 3-node cluster on Oracle ARM).
# Listener:    TLS-terminated locally; cert from PKI bootstrap (/openbao/config/tls/).
# Audit:       file sink — consumed by F10 otel-collector → obs.events Iceberg table.
# Seal:        Shamir by default. Auto-unseal via cloudkms stanza added at cutover.

ui = true
disable_mlock = false

storage "raft" {
  path    = "/openbao/data"
  node_id = "sitidos-openbao-1"

  # Add retry_join stanzas when scaling to multi-node:
  # retry_join { leader_api_addr = "https://openbao-2:8200" }
  # retry_join { leader_api_addr = "https://openbao-3:8200" }
}

listener "tcp" {
  address       = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"

  # TLS — cert + key issued by the PKI engine after bootstrap; mounted RO.
  tls_cert_file = "/openbao/config/tls/openbao.crt"
  tls_key_file  = "/openbao/config/tls/openbao.key"

  # mTLS for the F20 destroyKey path. PKI engine's CA cert is the verification root.
  tls_client_ca_file = "/openbao/config/tls/sitidos-internal-ca.crt"
  tls_require_and_verify_client_cert = false   # per-listener default off; F20's auth method
                                               # enables it at the auth/cert/ level.
}

api_addr     = "https://openbao:8200"
cluster_addr = "https://openbao:8201"

# Audit sink — file. otel-collector filelog receiver tails this and forwards to
# parquet-writer → obs.events. Every transit/encrypt, transit/decrypt, and
# transit/keys/* operation lands here with the calling AppRole / mTLS subject.
#
# NOTE: enabling audit happens via `bao audit enable file` post-init; this stanza
# does NOT enable it — the bootstrap script does. Audit file path documented here for ops.
# audit_file_path = "/openbao/audit/audit.log"
