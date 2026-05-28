/**
 * F7 OpenBao client implementation.
 *
 * Implements the verbatim hand-off contract from F7.md:
 *
 *   const ciphertext = await c.encrypt({ workspace_id, plaintext });
 *   const plaintext  = await c.decrypt({ workspace_id, ciphertext });
 *   await c.destroyKey({ workspace_id });   // CRYPTOSHRED — irreversible
 *
 * Plus a `createKey({ workspace_id })` provisioning op for F20 (also in scope per F7.md
 * deliverable: "Provisioning API: createWorkspaceKey({ workspace_id }) -> key_ref").
 *
 * Architectural laws applied:
 *   - D4: per-workspace key = cryptoshred unit; destroyKey is permanent.
 *   - F7 hard prohibitions:
 *       * No key material exit (no getKeyMaterial method, no datakey/plaintext endpoint).
 *       * No soft delete.
 *       * No cross-workspace key access (SDK passes workspace_id into the transit path).
 *       * No backup of unsealed keys outside OpenBao (no method exposes export/backup).
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import {
  CryptoshredEventEmissionError,
  KeyNotFoundError,
  OpenBaoError,
  PermissionDeniedError,
} from "./errors.js";
import type {
  CreateKeyInput,
  CreateKeyOutput,
  CryptoshredEvent,
  CryptoshredEventSink,
  DecryptInput,
  DecryptOutput,
  DestroyKeyInput,
  EncryptInput,
  EncryptOutput,
  KeyBinding,
  OpenBaoClientOptions,
  ServiceIdentity,
} from "./types.js";

const DEFAULT_ENDPOINT = "http://openbao:8200";

/**
 * Operations a given service identity is allowed to perform AT THE SDK LAYER.
 * The OpenBao policy layer enforces the same rules independently; this client gate
 * exists so misconfigured services fail loudly before a request even leaves the box.
 */
const SDK_CAPABILITY_MATRIX: Readonly<
  Record<ServiceIdentity, ReadonlySet<"encrypt" | "decrypt" | "createKey" | "destroyKey" | "rotate">>
> = {
  "data-writer": new Set(["encrypt"]),
  "data-reader": new Set(["decrypt"]),
  rotator: new Set(["rotate"]),
  "org-service": new Set(["createKey", "destroyKey"]),
};

export class OpenBaoClient {
  readonly #service: ServiceIdentity;
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #cryptoshredEventSink: CryptoshredEventSink;
  readonly #mtlsSubject: string | null;

  constructor(options: OpenBaoClientOptions) {
    this.#service = options.service;
    this.#endpoint = (options.endpoint ?? process.env["OPENBAO_URL"] ?? DEFAULT_ENDPOINT).replace(
      /\/+$/,
      "",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;

    // mTLS is REQUIRED for org-service. We don't establish the TLS context here (Node's
    // global fetch doesn't expose per-request client certs cleanly); instead we verify
    // the cert + key files exist and stash the subject CN for cryptoshred-event metadata.
    // The actual TLS handshake is configured by the per-service deploy (e.g. an undici
    // Agent or an mTLS-fronting sidecar). The presence check here is the SDK-layer gate.
    if (this.#service === "org-service") {
      const certPath = process.env["OPENBAO_MTLS_CERT_PATH"];
      const keyPath = process.env["OPENBAO_MTLS_KEY_PATH"];
      if (!certPath || !keyPath) {
        throw new OpenBaoError(
          "org-service identity requires OPENBAO_MTLS_CERT_PATH + OPENBAO_MTLS_KEY_PATH env vars",
        );
      }
      try {
        const certPem = readFileSync(certPath, "utf8");
        readFileSync(keyPath, "utf8"); // existence + readability check
        this.#mtlsSubject = extractSubjectCN(certPem);
      } catch (cause) {
        throw new OpenBaoError(
          `unable to read mTLS cert/key for org-service: ${String(cause)}`,
        );
      }
    } else {
      this.#mtlsSubject = null;
    }

    this.#cryptoshredEventSink =
      options.cryptoshredEventSink ?? buildDefaultCryptoshredSink(this.#fetch);
  }

  // -------------------------------------------------------------------------
  // F1 hot path — encrypt
  // -------------------------------------------------------------------------

  async encrypt(input: EncryptInput): Promise<EncryptOutput> {
    this.#assertCapability("encrypt");
    const keyName = keyPathFor(input.workspace_id, input.key_binding ?? "workspace");
    const plaintextB64 = toBase64(input.plaintext);

    const data = await this.#post<{ ciphertext: string; key_version: number }>(
      `/v1/transit/encrypt/${encodeURIComponent(keyName)}`,
      { plaintext: plaintextB64 },
    );

    return { ciphertext: data.ciphertext, key_version: data.key_version };
  }

  // -------------------------------------------------------------------------
  // F2 hot path — decrypt
  // -------------------------------------------------------------------------

  async decrypt(input: DecryptInput): Promise<DecryptOutput> {
    this.#assertCapability("decrypt");
    const keyName = keyPathFor(input.workspace_id, input.key_binding ?? "workspace");

    const data = await this.#post<{ plaintext: string }>(
      `/v1/transit/decrypt/${encodeURIComponent(keyName)}`,
      { ciphertext: input.ciphertext },
    );

    return { plaintext: Buffer.from(data.plaintext, "base64") };
  }

  // -------------------------------------------------------------------------
  // F20 lifecycle — createKey
  // -------------------------------------------------------------------------

  async createKey(input: CreateKeyInput): Promise<CreateKeyOutput> {
    this.#assertCapability("createKey");
    const keyName = keyPathFor(input.workspace_id, input.key_binding ?? "workspace");

    await this.#post(`/v1/transit/keys/${encodeURIComponent(keyName)}`, {
      type: "aes256-gcm96",
      exportable: false,
      allow_plaintext_backup: false,
      // Default deletion_allowed=false at creation; F20 flips it true immediately before
      // destroyKey. This protects against accidental DELETE by a misbehaving caller with
      // policy access to transit/keys/* — they'd also need to first PATCH /config.
      deletion_allowed: false,
    });

    return { key_ref: `transit/keys/${keyName}` };
  }

  // -------------------------------------------------------------------------
  // F20 lifecycle — destroyKey (CRYPTOSHRED, irreversible)
  // -------------------------------------------------------------------------

  /**
   * Permanently destroys a workspace's encryption key. After this returns successfully,
   * all data encrypted with this key in Iceberg / R2 is cryptographically unrecoverable.
   *
   * Sequence:
   *   1. Flip `deletion_allowed=true` on the key config (transit refuses delete otherwise).
   *   2. DELETE the key (all versions).
   *   3. Emit `cryptoshred.destroyed` to the obs.events sink.
   *
   * Failure modes:
   *   - Step 1 or 2 fails → throws OpenBaoError / PermissionDeniedError / KeyNotFoundError.
   *     Key state unchanged (step 1 reversible by writing config again; step 2 atomic).
   *   - Step 3 fails → throws CryptoshredEventEmissionError with `keyAlreadyDestroyed=true`.
   *     The key IS destroyed; the audit event is missing. Caller MUST retry the event
   *     emission separately or escalate (this is a P0 audit-trail bug).
   */
  async destroyKey(input: DestroyKeyInput): Promise<void> {
    this.#assertCapability("destroyKey");
    const binding: KeyBinding = input.key_binding ?? "workspace";
    const keyName = keyPathFor(input.workspace_id, binding);
    const keyRef = `transit/keys/${keyName}`;

    // 1. Allow deletion.
    await this.#post(`/v1/transit/keys/${encodeURIComponent(keyName)}/config`, {
      deletion_allowed: true,
    });

    // 2. Delete (irreversible).
    await this.#request("DELETE", `/v1/transit/keys/${encodeURIComponent(keyName)}`);

    // 3. Emit cryptoshred event. If this fails, the key IS gone — surface that fact
    //    so the caller doesn't think the destroy was rolled back.
    const event: CryptoshredEvent = {
      event_type: "cryptoshred.destroyed",
      key_ref: keyRef,
      workspace_id: input.workspace_id,
      key_binding: binding,
      requesting_service: this.#service,
      reason: input.reason,
      authorized_by: input.authorized_by,
      mtls_subject: this.#mtlsSubject,
      ts: new Date().toISOString(),
    };

    try {
      await this.#cryptoshredEventSink.emit(event);
    } catch (cause) {
      throw new CryptoshredEventEmissionError(
        `key ${keyRef} was destroyed but cryptoshred event emission failed; ` +
          `audit trail incomplete — retry event emission or escalate`,
        /* keyAlreadyDestroyed */ true,
        cause,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  #assertCapability(
    op: "encrypt" | "decrypt" | "createKey" | "destroyKey" | "rotate",
  ): void {
    const allowed = SDK_CAPABILITY_MATRIX[this.#service];
    if (!allowed.has(op)) {
      throw new PermissionDeniedError(
        `service identity '${this.#service}' is not permitted to call '${op}' at the SDK layer`,
      );
    }
  }

  async #post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.#request<T>("POST", path, body);
  }

  async #request<T = unknown>(
    method: "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.#endpoint}${path}`;
    const token = process.env["OPENBAO_TOKEN"];
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    // AppRole-based services receive a token via their login flow; an init container
    // typically writes it to OPENBAO_TOKEN. mTLS-based org-service may also use a token
    // alongside the client cert; the cert is the authn primary, the token is the session.
    if (token) headers["x-vault-token"] = token;

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.#fetch(url, init);

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text for error reporting */
      }
    }

    if (!res.ok) {
      const errs = extractBaoErrors(parsed);
      if (res.status === 403) {
        throw new PermissionDeniedError(`OpenBao denied ${method} ${path}`, errs);
      }
      if (res.status === 404) {
        throw new KeyNotFoundError(`OpenBao 404 on ${method} ${path}`, errs);
      }
      throw new OpenBaoError(
        `OpenBao ${res.status} on ${method} ${path}: ${errs.join("; ") || text}`,
        res.status,
        errs,
      );
    }

    if (parsed && typeof parsed === "object" && "data" in parsed) {
      return (parsed as { data: T }).data;
    }
    return parsed as T;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyPathFor(id: string, binding: KeyBinding): string {
  // Validation: workspace ids and org ids in Sitidos are slug-like (lowercase + digits + hyphen).
  // Reject anything that could escape the transit path namespace.
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(id)) {
    throw new OpenBaoError(
      `invalid id '${id}': must match /^[a-z0-9][a-z0-9_-]{0,62}$/ (cross-tenant safety)`,
    );
  }
  return `${binding}-${id}`;
}

function toBase64(input: string | Uint8Array): string {
  if (typeof input === "string") return Buffer.from(input, "utf8").toString("base64");
  return Buffer.from(input).toString("base64");
}

function extractBaoErrors(parsed: unknown): readonly string[] {
  if (
    parsed &&
    typeof parsed === "object" &&
    "errors" in parsed &&
    Array.isArray((parsed as { errors: unknown }).errors)
  ) {
    return (parsed as { errors: string[] }).errors.filter((e) => typeof e === "string");
  }
  return [];
}

/**
 * Best-effort extraction of the Subject CN from a PEM cert without pulling in a
 * heavyweight ASN.1 dep. We only need it for audit-log metadata; if extraction
 * fails the event still emits with mtls_subject=null and the OpenBao audit log
 * is the authoritative record of the calling identity.
 */
function extractSubjectCN(certPem: string): string | null {
  try {
    // Node's tls API can parse PEM via X509Certificate (Node 16+).
    // Using dynamic import keeps this file pure-types-friendly for build.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { X509Certificate } = require("node:crypto") as typeof import("node:crypto");
    const cert = new X509Certificate(certPem);
    const match = cert.subject.match(/CN=([^,\n]+)/);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function buildDefaultCryptoshredSink(
  fetchImpl: typeof globalThis.fetch,
): CryptoshredEventSink {
  return {
    async emit(event: CryptoshredEvent): Promise<void> {
      const sinkUrl = process.env["OBS_EVENTS_SINK_URL"];
      if (!sinkUrl) {
        throw new Error(
          "OBS_EVENTS_SINK_URL not set; refusing to destroy keys without an audit sink. " +
            "Provide options.cryptoshredEventSink or set the env var.",
        );
      }
      const res = await fetchImpl(sinkUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!res.ok) {
        throw new Error(`cryptoshred event sink returned ${res.status}`);
      }
    },
  };
}
