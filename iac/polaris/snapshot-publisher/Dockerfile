# F14 — Polaris snapshot publisher sidecar
#
# Polls Polaris for new Iceberg snapshots across the 7 sitidos namespaces and
# republishes events to Valkey pub/sub channel `polaris.snapshots` for F2
# (reader cache invalidation) and F17 (ISR-at-edge invalidation bus).
#
# ARM64 only — bit-identical between macbook (dev) and Oracle Ampere (prod).

FROM python:3.12-alpine
LABEL sitidos.foundation=F14
LABEL sitidos.arm64=true

RUN apk add --no-cache curl ca-certificates \
 && pip install --no-cache-dir 'requests==2.32.3' 'redis==5.0.8'

WORKDIR /app
COPY publisher.py /app/publisher.py

USER nobody
ENTRYPOINT ["python", "-u", "/app/publisher.py"]
