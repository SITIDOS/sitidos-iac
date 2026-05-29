// @sitidos/openbao-client — public surface.
//
// Hand-off contract (F7 prompt — VERBATIM):
//
//   import { OpenBaoClient } from "@sitidos/openbao-client";
//   const c = new OpenBaoClient({ service: "data-writer" });
//   const ciphertext = await c.encrypt({ workspace_id, plaintext });
//   const plaintext = await c.decrypt({ workspace_id, ciphertext });
//   await c.destroyKey({ workspace_id });   // CRYPTOSHRED — irreversible

export { OpenBaoClient } from "./client.js";
export type {
  OpenBaoClientOptions,
  ServiceIdentity,
  EncryptInput,
  EncryptOutput,
  DecryptInput,
  DecryptOutput,
  CreateKeyInput,
  CreateKeyOutput,
  DestroyKeyInput,
  KeyBinding,
  CryptoshredEventSink,
} from "./types.js";
export {
  OpenBaoError,
  PermissionDeniedError,
  KeyNotFoundError,
  CryptoshredEventEmissionError,
} from "./errors.js";
