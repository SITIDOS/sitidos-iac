/**
 * Typed errors thrown by @sitidos/openbao-client.
 *
 * Callers should match on these classes (instanceof) rather than parsing messages.
 * Hot paths (F1 writer, F2 reader) almost always want to bubble these to OTel.
 */

export class OpenBaoError extends Error {
  public override readonly name: string = "OpenBaoError";
  constructor(
    message: string,
    public readonly status?: number,
    public readonly baoErrors?: readonly string[],
  ) {
    super(message);
  }
}

export class PermissionDeniedError extends OpenBaoError {
  public override readonly name = "PermissionDeniedError";
  constructor(message: string, baoErrors?: readonly string[]) {
    super(message, 403, baoErrors);
  }
}

export class KeyNotFoundError extends OpenBaoError {
  public override readonly name = "KeyNotFoundError";
  constructor(message: string, baoErrors?: readonly string[]) {
    super(message, 404, baoErrors);
  }
}

/**
 * Raised when `destroyKey` cannot emit the cryptoshred event. This is treated as a
 * destroy failure — the caller (F20) MUST retry or escalate; silently dropping the
 * event would violate the audit-trail invariant.
 *
 * The key state at the time of this error is ambiguous (OpenBao may have already
 * destroyed it, since the event is emitted AFTER the DELETE call succeeds). The
 * `keyAlreadyDestroyed` flag distinguishes the two cases.
 */
export class CryptoshredEventEmissionError extends OpenBaoError {
  public override readonly name = "CryptoshredEventEmissionError";
  constructor(
    message: string,
    public readonly keyAlreadyDestroyed: boolean,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}
