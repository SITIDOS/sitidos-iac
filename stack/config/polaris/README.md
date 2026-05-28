# F14 — Apache Polaris config directory

This directory is bind-mounted into the `polaris` service at `/opt/polaris/config:ro`.

Polaris 1.5.0 is bootstrapped primarily via environment variables (see
`compose/sitidos.yml`) and the bootstrap script `iac/polaris/bootstrap.sh` (to be authored by
the F14 agent).

Files expected here in future:

- `application.properties` — fine-grained Polaris settings (only if env-var coverage is
  insufficient; prefer env vars per ADR-0005 portability rule).
- `realms.json` — declarative realm config if the F14 agent decides to manage realms via file
  instead of API calls.

For now this is a placeholder. F14 agent fills it.
