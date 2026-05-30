#!/usr/bin/env python3
"""
catalog-rebuild — reconstruct the Polaris catalog from R2 (Iceberg is source of truth).

Polaris 1.5.0's only durable persistence (relational-jdbc) is build-time-fixed to
PostgreSQL in the locked image, which D1 bans. Per the metastore decision (option B),
we run Polaris `in-memory` and treat R2/Iceberg as the source of truth: this tool
walks R2 for every table's latest *.metadata.json and re-registers it into Polaris,
so a Polaris restart (which drops the in-memory catalog) is fully recoverable with
ZERO SQL and zero law change.

Env (from /tmp/parity/r2.env): R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT_URL,
R2_BUCKET, POLARIS_ROOT_CREDS (realm,clientId,clientSecret). POLARIS_URL optional
(default http://localhost:8181).
"""
import os, sys, hashlib, hmac, datetime, urllib.parse, xml.etree.ElementTree as ET
import requests

AK = os.environ["R2_ACCESS_KEY_ID"]; SK = os.environ["R2_SECRET_ACCESS_KEY"]
ENDPOINT = os.environ["R2_ENDPOINT_URL"]; HOST = ENDPOINT.replace("https://", "")
BUCKET = os.environ["R2_BUCKET"]
REALM, ROOT_ID, ROOT_SECRET = os.environ["POLARIS_ROOT_CREDS"].split(",", 2)
POLARIS = os.environ.get("POLARIS_URL", "http://localhost:8181")
CATALOG = os.environ.get("POLARIS_CATALOG", "sitidos")
WAREHOUSE_PREFIX = os.environ.get("POLARIS_WAREHOUSE_PREFIX", "sitidos")  # base path in bucket

# ---------- S3 SigV4 (ListObjectsV2) ----------
def _sign(k, m): return hmac.new(k, m.encode(), hashlib.sha256).digest()
def _sigkey(k, d, r, s): return _sign(_sign(_sign(_sign(("AWS4"+k).encode(), d), r), s), "aws4_request")

def s3_list(prefix):
    """Yield (key, last_modified) for every object under prefix, following pagination."""
    token = None
    while True:
        params = {"list-type": "2", "prefix": prefix}
        if token: params["continuation-token"] = token
        # canonical query string: RFC3986-encoded, sorted by key
        cq = "&".join(f"{urllib.parse.quote(k, safe='~')}={urllib.parse.quote(v, safe='~')}"
                      for k, v in sorted(params.items()))
        now = datetime.datetime.now(datetime.timezone.utc)
        amz = now.strftime("%Y%m%dT%H%M%SZ"); ds = now.strftime("%Y%m%d")
        ph = hashlib.sha256(b"").hexdigest()
        cu = f"/{BUCKET}"
        ch = f"host:{HOST}\nx-amz-content-sha256:{ph}\nx-amz-date:{amz}\n"
        sh = "host;x-amz-content-sha256;x-amz-date"
        cr = f"GET\n{cu}\n{cq}\n{ch}\n{sh}\n{ph}"
        cs = f"AWS4-HMAC-SHA256\n{amz}\n{ds}/auto/s3/aws4_request\n" + hashlib.sha256(cr.encode()).hexdigest()
        sig = hmac.new(_sigkey(SK, ds, "auto", "s3"), cs.encode(), hashlib.sha256).hexdigest()
        auth = (f"AWS4-HMAC-SHA256 Credential={AK}/{ds}/auto/s3/aws4_request, "
                f"SignedHeaders={sh}, Signature={sig}")
        r = requests.get(f"{ENDPOINT}/{BUCKET}?{cq}",
                         headers={"Authorization": auth, "x-amz-date": amz, "x-amz-content-sha256": ph},
                         timeout=20)
        r.raise_for_status()
        ns = "{http://s3.amazonaws.com/doc/2006-03-01/}"
        root = ET.fromstring(r.content)
        for c in root.iter(f"{ns}Contents"):
            yield c.find(f"{ns}Key").text, c.find(f"{ns}LastModified").text
        if root.findtext(f"{ns}IsTruncated") == "true":
            token = root.findtext(f"{ns}NextContinuationToken")
        else:
            break

# ---------- discover latest metadata.json per table ----------
def discover_tables():
    """Return {(namespace_tuple, table): metadata_location} for the newest metadata.json each."""
    latest = {}  # (ns, table) -> (lastmod, key)
    for key, lm in s3_list(WAREHOUSE_PREFIX + "/"):
        # expect <warehouse>/<ns...>/<table>/metadata/<file>.metadata.json
        if "/metadata/" not in key or not key.endswith(".metadata.json"):
            continue
        head, _ = key.split("/metadata/", 1)
        parts = head.split("/")            # [warehouse, ns..., table]
        if len(parts) < 3:                 # need warehouse + >=1 ns + table
            continue
        table = parts[-1]; ns = tuple(parts[1:-1])
        ident = (ns, table)
        if ident not in latest or lm > latest[ident][0]:
            latest[ident] = (lm, key)
    return {ident: f"s3://{BUCKET}/{key}" for ident, (lm, key) in latest.items()}

# ---------- Polaris REST ----------
def oauth_token():
    r = requests.post(f"{POLARIS}/api/catalog/v1/oauth/tokens",
                      data={"grant_type": "client_credentials", "client_id": ROOT_ID,
                            "client_secret": ROOT_SECRET, "scope": "PRINCIPAL_ROLE:ALL"}, timeout=20)
    r.raise_for_status(); return r.json()["access_token"]

def ensure_catalog(tok):
    h = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    existing = requests.get(f"{POLARIS}/api/management/v1/catalogs", headers=h, timeout=20).json()
    if any(c["name"] == CATALOG for c in existing.get("catalogs", [])):
        return False
    body = {"catalog": {"name": CATALOG, "type": "INTERNAL",
            "properties": {"default-base-location": f"s3://{BUCKET}/{WAREHOUSE_PREFIX}"},
            "storageConfigInfo": {"storageType": "S3", "allowedLocations": [f"s3://{BUCKET}/*"],
                "endpoint": ENDPOINT, "pathStyleAccess": True, "stsUnavailable": True, "region": "auto"}}}
    requests.post(f"{POLARIS}/api/management/v1/catalogs", headers=h, json=body, timeout=20).raise_for_status()
    # grant role so we can register tables
    requests.post(f"{POLARIS}/api/management/v1/catalogs/{CATALOG}/catalog-roles", headers=h,
                  json={"catalogRole": {"name": "admin"}}, timeout=20)
    requests.put(f"{POLARIS}/api/management/v1/catalogs/{CATALOG}/catalog-roles/admin/grants", headers=h,
                 json={"grant": {"type": "catalog", "privilege": "CATALOG_MANAGE_CONTENT"}}, timeout=20)
    requests.put(f"{POLARIS}/api/management/v1/principal-roles/service_admin/catalog-roles/{CATALOG}",
                 headers=h, json={"catalogRole": {"name": "admin"}}, timeout=20)
    return True

def ensure_namespace(tok, ns):
    h = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    for i in range(1, len(ns) + 1):
        sub = ns[:i]
        requests.post(f"{POLARIS}/api/catalog/v1/{CATALOG}/namespaces", headers=h,
                      json={"namespace": list(sub)}, timeout=20)  # 409 if exists is fine

def register_table(tok, ns, table, metadata_location):
    h = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    ns_path = "\x1f".join(ns)
    r = requests.post(f"{POLARIS}/api/catalog/v1/{CATALOG}/namespaces/{urllib.parse.quote(ns_path)}/register",
                      headers=h, json={"name": table, "metadata-location": metadata_location}, timeout=20)
    return r.status_code, r.text[:160]

def main():
    print(f"→ discovering tables under s3://{BUCKET}/{WAREHOUSE_PREFIX}/ ...")
    tables = discover_tables()
    print(f"  found {len(tables)} table(s) in R2")
    tok = oauth_token()
    created = ensure_catalog(tok)
    print(f"  catalog '{CATALOG}': {'created' if created else 'already present'}")
    ok = skip = 0
    for (ns, table), loc in sorted(tables.items()):
        ensure_namespace(tok, ns)
        code, msg = register_table(tok, ns, table, loc)
        label = ".".join(ns + (table,))
        if code in (200, 201):
            print(f"  ✓ registered {label}"); ok += 1
        elif code == 409:
            print(f"  = already in catalog {label}"); skip += 1
        else:
            print(f"  ✗ {label} -> HTTP {code} {msg}")
    print(f"DONE: {ok} registered, {skip} already present, {len(tables)} total in R2")

if __name__ == "__main__":
    main()
