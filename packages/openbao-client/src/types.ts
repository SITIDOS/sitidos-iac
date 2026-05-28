/**
 * Public types for @sitidos/openbao-client.
 *
 * Service identity governs which transit operations are permitted at the SDK layer
 * (belt-and-suspenders with the OpenBao policy enforcement at the server layer).
 */

/** The Sitidos service calling OpenBao. Determines auth method + permitted ops. */
export type ServiceIdentity =
  | "data-writer"   // F1: encrypt only
  | "data-reader"   // F2: decrypt only
  | "rotator"       // F7: rotate only
  | "org-service";  // F20: createKey + destroyKey (mTLS required)

/** `workspace` keys live at `transit/keys/workspace-${id}`; `org` at `transit/keys/org-${id}`. */
export type KeyBinding = "workspace" | "org";

export interface OpenBaoClientOptions {
  /** Which Sitidos service is calling. Drives auth + capability gate. */
  readonly service: ServiceIdentity;

  /**
   * OpenBao API endpoint. Defaults to `process.env.OPENBAO_URL` then `http://openbao:8200`
   * (the docker-network service name from `stack/compose/sitidos.yml`).
   */
  readonly endpoint?: string;

  /**
   * Sink for cryptoshred events emitted by `destroyKey`. If omitted, a default HTTP POST
   * sink is constructed from `process.env.OBS_EVENTS_SINK_URL`. If THAT is also unset,
   * `destroyKey` will throw `CryptoshredEventEmissionError` rather than silently destroy
   * a key without an auditable event (D4 + I11-style audit-trail invariant).
   */
  readonly cryptoshredEventSink?: CryptoshredEventSink;

  /** Override fetch (for tests). Defaults to global fetch (Node 22 has it natively). */
  readonly fetch?: typeof globalThis.fetch;
}

export interface EncryptInput {
  readonly workspace_id: string;
  /** Raw plaintext as UTF-8 string OR Uint8Array. Encoded to base64 before transmit. */
  readonly plaintext: string | Uint8Array;
  /** Optional key binding. Defaults to "workspace". */
  readonly key_binding?: KeyBinding;
}

export interface EncryptOutput {
  /** OpenBao transit ciphertext of the form `vault:v<version>:<base64>`. Store as-is. */
  readonly ciphertext: string;
  /** Key version used. Useful for back-compat tracking; ciphertext alone is sufficient to decrypt. */
  readonly key_version: number;
}

export interface DecryptInput {
  readonly workspace_id: string;
  /** Transit ciphertext (`vault:vN:...`) produced by a prior `encrypt` call. */
  readonly ciphertext: string;
  readonly key_binding?: KeyBinding;
}

export interface DecryptOutput {
  /** Plaintext bytes. Caller decides how to interpret (UTF-8, raw, etc.). */
  readonly plaintext: Uint8Array;
}

export interface CreateKeyInput {
  readonly workspace_id: string;
  readonly key_binding?: KeyBinding;
}

export interface CreateKeyOutput {
  /** Opaque key reference; for transit it's the key path under `transit/keys/`. */
  readonly key_ref: string;
}

export interface DestroyKeyInput {
  readonly workspace_id: string;
  readonly key_binding?: KeyBinding;
  /**
   * Required attestation: the human/system reason for destruction. Logged in the
   * cryptoshred event. Examples: "workspace_deleted_by_admin",
   * "gdpr_article_17_request", "org_deletion_cascade".
   */
  readonly reason: string;
  /**
   * Required: identity of the entity that authorized the destroy. The mTLS subject
   * is recorded automatically; this is the upstream actor (e.g. Auth0 user id).
   */
  readonly authorized_by: string;
}

/**
 * Pluggable sink for cryptoshred events. Default impl POSTs JSON to
 * `process.env.OBS_EVENTS_SINK_URL`. Custom impls (e.g. direct Iceberg write via
 * the F1 writer) can be injected via OpenBaoClientOptions.cryptoshredEventSink.
 *
 * The sink MUST throw on failure; the client treats a failed event emission as a
 * destroy failure and re-raises so the caller knows the audit trail is incomplete.
 */
export interface CryptoshredEventSink {
  emit(event: CryptoshredEvent): Promise<void>;
}

export interface CryptoshredEvent {
  readonly event_type: "cryptoshred.destroyed";
  readonly key_ref: string;
  readonly workspace_id: string;
  readonly key_binding: KeyBinding;
  readonly requesting_service: ServiceIdentity;
  readonly reason: string;
  readonly authorized_by: string;
  readonly mtls_subject: string | null;
  readonly ts: string; // ISO 8601
}
