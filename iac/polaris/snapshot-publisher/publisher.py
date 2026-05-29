"""F14 — Polaris snapshot publisher sidecar.

Polls Polaris for the current snapshot id of every table in the 7 sitidos
namespaces (control, identity, esign, acl, obs, dataroom, crm) and publishes
*changes* to a Valkey pub/sub channel.

Event schema (one JSON object per Valkey publish):

    {
      "namespace": "dataroom",
      "table":     "documents",
      "snapshot_id":         12345,
      "parent_snapshot_id":  12344,
      "timestamp_ms":        1700000000000,
      "operation":           "append" | "overwrite" | "delete" | "replace",
      "source":              "F14/polaris-snapshot-publisher"
    }

Consumers:
  - F2 (DuckDB reader) — drop cached scan plans for the affected table.
  - F17 (ISR revalidator) — compute tag set per D7 taxonomy and call Vercel
    revalidation + Cloudflare cache purge.

Design notes:
  - Stateless across restarts: on (re)start, we snapshot the *current* head
    and only publish *changes* observed thereafter. The first cycle does NOT
    emit events for already-existing snapshots — F17 / F2 do a cold-start
    full refresh of their own per the F17 runbook.
  - No direct mutation of Polaris state — read-only metadata calls only.
  - Hard prohibition: this sidecar does NOT write to Iceberg tables.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
from typing import Dict, Iterable

import redis
import requests

LOG = logging.getLogger("polaris-snapshot-publisher")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")

POLARIS_URL = os.environ["POLARIS_URL"].rstrip("/")
POLARIS_REALM = os.environ.get("POLARIS_REALM", "sitidos")
POLARIS_PRINCIPAL_ID = os.environ["POLARIS_PRINCIPAL_ID"]
POLARIS_PRINCIPAL_SECRET = os.environ["POLARIS_PRINCIPAL_SECRET"]
VALKEY_URL = os.environ.get("VALKEY_URL", "redis://valkey:6379")
VALKEY_CHANNEL = os.environ.get("VALKEY_CHANNEL", "polaris.snapshots")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_SECONDS", "5"))
NAMESPACES = [n.strip() for n in os.environ.get(
    "NAMESPACES", "control,identity,esign,acl,obs,dataroom,crm"
).split(",") if n.strip()]

# (namespace, table) -> last-seen snapshot id
SEEN: Dict[tuple[str, str], int] = {}
RUNNING = True


def _stop(*_a):  # pragma: no cover
    global RUNNING
    RUNNING = False
    LOG.info("stop signal received; finishing current cycle")


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)


def get_token() -> str:
    resp = requests.post(
        f"{POLARIS_URL}/api/catalog/v1/oauth/tokens",
        data={
            "grant_type": "client_credentials",
            "client_id": POLARIS_PRINCIPAL_ID,
            "client_secret": POLARIS_PRINCIPAL_SECRET,
            "scope": "PRINCIPAL_ROLE:ALL",
        },
        headers={"Polaris-Realm": POLARIS_REALM},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def list_tables(token: str, namespace: str) -> Iterable[str]:
    resp = requests.get(
        f"{POLARIS_URL}/api/catalog/v1/{POLARIS_REALM}/namespaces/{namespace}/tables",
        headers={"Authorization": f"Bearer {token}", "Polaris-Realm": POLARIS_REALM},
        timeout=10,
    )
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    for ident in resp.json().get("identifiers", []):
        yield ident["name"]


def load_table(token: str, namespace: str, table: str) -> dict | None:
    resp = requests.get(
        f"{POLARIS_URL}/api/catalog/v1/{POLARIS_REALM}/namespaces/{namespace}/tables/{table}",
        headers={"Authorization": f"Bearer {token}", "Polaris-Realm": POLARIS_REALM},
        timeout=10,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def current_snapshot(table_meta: dict) -> dict | None:
    md = table_meta.get("metadata", {})
    current_id = md.get("current-snapshot-id")
    if current_id in (None, -1):
        return None
    for snap in md.get("snapshots", []):
        if snap.get("snapshot-id") == current_id:
            return snap
    return None


def publish(r: "redis.Redis", namespace: str, table: str, snap: dict) -> None:
    event = {
        "namespace": namespace,
        "table": table,
        "snapshot_id": snap.get("snapshot-id"),
        "parent_snapshot_id": snap.get("parent-snapshot-id"),
        "timestamp_ms": snap.get("timestamp-ms"),
        "operation": (snap.get("summary") or {}).get("operation"),
        "source": "F14/polaris-snapshot-publisher",
    }
    r.publish(VALKEY_CHANNEL, json.dumps(event, separators=(",", ":")))
    LOG.info("published %s.%s snapshot=%s op=%s",
             namespace, table, event["snapshot_id"], event["operation"])


def cycle(token: str, r: "redis.Redis", warm: bool) -> None:
    for ns in NAMESPACES:
        for tbl in list_tables(token, ns):
            meta = load_table(token, ns, tbl)
            if meta is None:
                continue
            snap = current_snapshot(meta)
            if snap is None:
                continue
            sid = snap.get("snapshot-id")
            key = (ns, tbl)
            prev = SEEN.get(key)
            if sid != prev:
                if warm:
                    publish(r, ns, tbl, snap)
                SEEN[key] = sid


def main() -> int:
    LOG.info("starting; polaris=%s valkey=%s channel=%s namespaces=%s interval=%ss",
             POLARIS_URL, VALKEY_URL, VALKEY_CHANNEL, NAMESPACES, POLL_INTERVAL)
    r = redis.Redis.from_url(VALKEY_URL, socket_timeout=5, decode_responses=False)
    token = get_token()
    token_issued = time.time()
    warm = False  # first pass primes SEEN without publishing
    while RUNNING:
        try:
            # rotate token hourly (Polaris OAuth default lifetime).
            if time.time() - token_issued > 3000:
                token = get_token()
                token_issued = time.time()
            cycle(token, r, warm)
            warm = True
        except requests.HTTPError as exc:
            LOG.warning("polaris http error: %s", exc)
            if exc.response is not None and exc.response.status_code in (401, 403):
                token = get_token()
                token_issued = time.time()
        except Exception as exc:  # noqa: BLE001 — sidecar must keep running
            LOG.exception("cycle error: %s", exc)
        for _ in range(POLL_INTERVAL):
            if not RUNNING:
                break
            time.sleep(1)
    LOG.info("shutdown clean")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
