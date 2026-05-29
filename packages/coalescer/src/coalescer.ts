/**
 * F8 — In-process coalescer.
 *
 * Semantics:
 *   - When a producer for `key` is in-flight, every subsequent `run(key, ...)`
 *     within `ttlMs` awaits the same Promise.
 *   - When the producer resolves, the cached result is served to subsequent
 *     callers for up to `ttlMs` from FIRST CALL TIME (sliding window NOT
 *     reset on hit — F4 wants a hard 100ms cap on staleness).
 *   - When the producer rejects, the cache entry is dropped immediately so
 *     the next caller re-attempts (no negative caching — F4 circuit-breaker
 *     handles persistent upstream failure per D9b "fails CLOSED").
 *   - Entries are evicted lazily on access; an optional sweep interval keeps
 *     the map small under load.
 *
 * This primitive is intentionally simple and dependency-free. It does NOT
 * know about Valkey. Cross-process coalescing is layered on top via
 * @sitidos/valkey-client's `coalescerLow.tryAcquire()`.
 */

export interface CoalescerOptions {
  /**
   * Default window in milliseconds. F4 (D9b) uses 100ms. Hard upper bound is
   * 5000ms — coalescing for longer than that would mask real upstream errors
   * and violate the D9b "fails CLOSED" invariant.
   */
  defaultTtlMs?: number;
  /**
   * Optional periodic sweep interval. Defaults to 1000ms. Pass `null` to
   * disable (test environments may want manual sweep via `.sweep()`).
   */
  sweepIntervalMs?: number | null;
  /**
   * Time source. Override in tests for deterministic windowing.
   */
  now?: () => number;
}

interface Entry<T> {
  /** Wall-clock ms at which the entry expires (sliding from first call). */
  expiresAt: number;
  /** The in-flight or settled promise. */
  promise: Promise<T>;
}

const HARD_MAX_TTL_MS = 5_000;

export class Coalescer {
  readonly #map = new Map<string, Entry<unknown>>();
  readonly #defaultTtlMs: number;
  readonly #now: () => number;
  readonly #sweepHandle: ReturnType<typeof setInterval> | null;

  constructor(opts: CoalescerOptions = {}) {
    this.#defaultTtlMs = opts.defaultTtlMs ?? 100;
    if (this.#defaultTtlMs <= 0 || this.#defaultTtlMs > HARD_MAX_TTL_MS) {
      throw new RangeError(
        `[coalescer] defaultTtlMs must be in (0, ${HARD_MAX_TTL_MS}], got ${this.#defaultTtlMs}`,
      );
    }
    this.#now = opts.now ?? Date.now;
    const sweepIntervalMs = opts.sweepIntervalMs === undefined ? 1_000 : opts.sweepIntervalMs;
    if (sweepIntervalMs === null) {
      this.#sweepHandle = null;
    } else {
      this.#sweepHandle = setInterval(() => this.sweep(), sweepIntervalMs);
      // Don't keep the event loop alive just for sweeping.
      this.#sweepHandle.unref?.();
    }
  }

  /**
   * Coalesce `producer` under `key`. If an entry is in-flight or fresh,
   * returns the shared promise. Otherwise starts the producer.
   */
  async run<T>(
    key: string,
    producer: () => Promise<T>,
    opts: { ttlMs?: number } = {},
  ): Promise<T> {
    const ttlMs = opts.ttlMs ?? this.#defaultTtlMs;
    if (ttlMs <= 0 || ttlMs > HARD_MAX_TTL_MS) {
      throw new RangeError(
        `[coalescer] ttlMs must be in (0, ${HARD_MAX_TTL_MS}], got ${ttlMs}`,
      );
    }
    const now = this.#now();
    const existing = this.#map.get(key) as Entry<T> | undefined;
    if (existing && existing.expiresAt > now) {
      return existing.promise;
    }
    const promise = (async () => producer())();
    const entry: Entry<T> = { expiresAt: now + ttlMs, promise };
    this.#map.set(key, entry as Entry<unknown>);
    // On rejection, drop the entry immediately (no negative caching).
    promise.catch(() => {
      const current = this.#map.get(key);
      if (current === (entry as Entry<unknown>)) {
        this.#map.delete(key);
      }
    });
    return promise;
  }

  /** Evict expired entries. Called periodically; safe to call manually. */
  sweep(): void {
    const now = this.#now();
    for (const [key, entry] of this.#map) {
      if (entry.expiresAt <= now) {
        this.#map.delete(key);
      }
    }
  }

  /** Drop a specific key (e.g. on explicit invalidation). */
  invalidate(key: string): void {
    this.#map.delete(key);
  }

  /** Current size — for tests + observability. */
  get size(): number {
    return this.#map.size;
  }

  /** Stop the sweep interval. Call on graceful shutdown. */
  dispose(): void {
    if (this.#sweepHandle) clearInterval(this.#sweepHandle);
    this.#map.clear();
  }
}
