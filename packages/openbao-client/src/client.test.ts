/**
 * Smoke tests for OpenBaoClient. Uses a fake fetch — no real OpenBao required.
 *
 * Run: cd packages/openbao-client && pnpm test  (vitest)
 */

import { strict as assert } from "node:assert";
import { describe, it } from "vitest";

import { OpenBaoClient } from "./client.js";
import { CryptoshredEventEmissionError, PermissionDeniedError } from "./errors.js";
import type { CryptoshredEvent, CryptoshredEventSink } from "./types.js";

function fakeFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = handler(url, init ?? {});
    // The Web Response constructor rejects a body for null-body statuses
    // (101/204/205/304). OpenBao's destroyKey DELETE returns 204 No Content.
    const nullBody = status === 101 || status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

describe("OpenBaoClient capability gate", () => {
  it("rejects encrypt() called by data-reader at SDK layer", async () => {
    const c = new OpenBaoClient({
      service: "data-reader",
      endpoint: "http://test",
      fetch: fakeFetch(() => ({ status: 200, body: {} })),
    });
    await assert.rejects(
      () => c.encrypt({ workspace_id: "ws-a", plaintext: "hi" }),
      PermissionDeniedError,
    );
  });

  it("rejects destroyKey() called by data-writer at SDK layer", async () => {
    const c = new OpenBaoClient({
      service: "data-writer",
      endpoint: "http://test",
      fetch: fakeFetch(() => ({ status: 200, body: {} })),
    });
    await assert.rejects(
      () =>
        c.destroyKey({
          workspace_id: "ws-a",
          reason: "test",
          authorized_by: "test",
        }),
      PermissionDeniedError,
    );
  });
});

describe("OpenBaoClient encrypt/decrypt", () => {
  it("encodes plaintext to base64 and parses transit ciphertext response", async () => {
    const c = new OpenBaoClient({
      service: "data-writer",
      endpoint: "http://test",
      fetch: fakeFetch((url, init) => {
        assert.match(url, /\/v1\/transit\/encrypt\/workspace-ws-a$/);
        const body = JSON.parse(String(init.body)) as { plaintext: string };
        assert.equal(Buffer.from(body.plaintext, "base64").toString("utf8"), "hello");
        return { status: 200, body: { data: { ciphertext: "vault:v1:abc", key_version: 1 } } };
      }),
    });
    const out = await c.encrypt({ workspace_id: "ws-a", plaintext: "hello" });
    assert.equal(out.ciphertext, "vault:v1:abc");
    assert.equal(out.key_version, 1);
  });
});

describe("OpenBaoClient cross-tenant safety", () => {
  it("rejects workspace ids with path-escape characters", async () => {
    const c = new OpenBaoClient({
      service: "data-writer",
      endpoint: "http://test",
      fetch: fakeFetch(() => ({ status: 200, body: {} })),
    });
    await assert.rejects(
      () => c.encrypt({ workspace_id: "../etc/passwd", plaintext: "x" }),
      /invalid id/,
    );
  });
});

describe("OpenBaoClient destroyKey", () => {
  it("destroys key then emits cryptoshred event (org-service)", async () => {
    process.env["OPENBAO_MTLS_CERT_PATH"] = "/dev/null";
    process.env["OPENBAO_MTLS_KEY_PATH"] = "/dev/null";

    const calls: Array<{ method: string; url: string }> = [];
    const emitted: CryptoshredEvent[] = [];
    const sink: CryptoshredEventSink = {
      async emit(event) {
        emitted.push(event);
      },
    };

    const c = new OpenBaoClient({
      service: "org-service",
      endpoint: "http://test",
      cryptoshredEventSink: sink,
      fetch: fakeFetch((url, init) => {
        calls.push({ method: init.method ?? "GET", url });
        return { status: 204, body: null };
      }),
    });

    await c.destroyKey({
      workspace_id: "ws-doomed",
      reason: "test-deletion",
      authorized_by: "auth0|founder",
    });

    // Step 1: allow deletion. Step 2: DELETE the key.
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.method, "POST");
    assert.match(calls[0]?.url ?? "", /\/transit\/keys\/workspace-ws-doomed\/config$/);
    assert.equal(calls[1]?.method, "DELETE");
    assert.match(calls[1]?.url ?? "", /\/transit\/keys\/workspace-ws-doomed$/);

    // Event emitted with all required fields.
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.event_type, "cryptoshred.destroyed");
    assert.equal(emitted[0]?.workspace_id, "ws-doomed");
    assert.equal(emitted[0]?.requesting_service, "org-service");
    assert.equal(emitted[0]?.reason, "test-deletion");
  });

  it("surfaces CryptoshredEventEmissionError with keyAlreadyDestroyed=true when sink fails", async () => {
    process.env["OPENBAO_MTLS_CERT_PATH"] = "/dev/null";
    process.env["OPENBAO_MTLS_KEY_PATH"] = "/dev/null";

    const c = new OpenBaoClient({
      service: "org-service",
      endpoint: "http://test",
      cryptoshredEventSink: {
        async emit() {
          throw new Error("sink unavailable");
        },
      },
      fetch: fakeFetch(() => ({ status: 204, body: null })),
    });

    await assert.rejects(
      () =>
        c.destroyKey({
          workspace_id: "ws-x",
          reason: "r",
          authorized_by: "a",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CryptoshredEventEmissionError);
        assert.equal(err.keyAlreadyDestroyed, true);
        return true;
      },
    );
  });
});
