/**
 * F8 — ValkeyClient
 *
 * The single hand-off surface for every Sitidos service that touches Valkey.
 * Namespace builders are private; consumers can only call typed methods.
 *
 * Sub-5ms target per F8.md ("No latency carve-out; Valkey operations target
 * sub-5ms"). All operations are single round-trip; coalesce() is the only
 * primitive that may block on an inner async producer.
 */

import { Redis, type RedisOptions } from "iovalkey";
import {
  MAX_TTL_MS,
  REVALIDATE_PUBSUB_CHANNEL,
  coalescerKey,
  jwksKey,
  ratelimitKey,
  revalidateCursorKey,
  type RatelimitWindow,
} from "./namespaces.js";
import {
  decodeRevalidationEvent,
  encodeRevalidationEvent,
  type RevalidationEvent,
} from "./pubsub.js";

export interface ValkeyClientOptions {
  /**
   * Caller service name — recorded in the `ratelimit:${service}:...` namespace
   * and emitted on every operation as an OTel attribute (F10). Required so
   * that one client instance per service is the norm, and ratelimit keyspace
   * stays partitioned per service.
   */
  service: string;
  /**
   * Pre-built iovalkey client. Allows F10 instrumentation injection and lets
   * integration tests pass an in-process mock. Defaults to a localhost
   * connection to the standalone compose stack on host port 6380.
   */
  redis?: Redis;
  /** Override for the default localhost wiring. Ignored if `redis` is set. */
  connection?: RedisOptions;
}

export interface RatelimitResult {
  /** Count AFTER the bump. */
  count: number;
  /** Window length in ms (parsed from the requested label). */
  windowMs: number;
}

const WINDOW_MS: Record<RatelimitWindow, number> = {
  "1s": 1_000,
  "10s": 10_000,
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
};

export class ValkeyClient {
  readonly #service: string;
  readonly #redis: Redis;

  constructor(opts: ValkeyClientOptions) {
    if (!opts.service || typeof opts.service !== "string") {
      throw new TypeError("[valkey-client] options.service is required");
    }
    this.#service = opts.service;
    this.#redis =
      opts.redis ??
      new Redis({
        host: "127.0.0.1",
        port: 6380,
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        ...opts.connection,
      });
  }

  /** Underlying connection; exposed for graceful shutdown / health probes only. */
  get raw(): Redis {
    return this.#redis;
  }

  async quit(): Promise<void> {
    await this.#redis.quit();
  }

  // -------------------------------------------------------------------------
  // Ratelimit namespace
  // -------------------------------------------------------------------------

  readonly ratelimit = {
    /**
     * Increment the counter for (service, principal, window). Sets the TTL
     * to the window length on first hit. Returns the post-bump count.
     */
    bump: async (args: {
      key: string;
      window: RatelimitWindow;
    }): Promise<RatelimitResult> => {
      const k = ratelimitKey({
        service: this.#service,
        principalId: args.key,
        window: args.window,
      });
      const windowMs = WINDOW_MS[args.window];
      // INCR then EXPIRE only if first hit, via NX flag (Valkey 7+).
      const pipeline = this.#redis.multi();
      pipeline.incr(k);
      pipeline.expire(k, Math.ceil(windowMs / 1000), "NX");
      const results = await pipeline.exec();
      if (!results || results.length === 0) {
        throw new Error("[valkey-client] ratelimit.bump pipeline returned no result");
      }
      const incrResult = results[0];
      if (!incrResult || incrResult[0]) {
        throw incrResult?.[0] ?? new Error("[valkey-client] ratelimit.bump INCR failed");
      }
      const count = Number(incrResult[1]);
      return { count, windowMs };
    },

    /** Read the current count without bumping. Returns 0 if absent. */
    peek: async (args: {
      key: string;
      window: RatelimitWindow;
    }): Promise<number> => {
      const k = ratelimitKey({
        service: this.#service,
        principalId: args.key,
        window: args.window,
      });
      const value = await this.#redis.get(k);
      return value === null ? 0 : Number(value);
    },
  };

  // -------------------------------------------------------------------------
  // JWKS namespace
  // -------------------------------------------------------------------------

  readonly jwks = {
    /** Cache a JWK set for an issuer. TTL defaults to 10 minutes. */
    set: async (args: {
      issuer: string;
      jwks: object;
      ttl_ms?: number;
    }): Promise<void> => {
      const ttlMs = args.ttl_ms ?? 10 * 60 * 1000;
      assertTtl(ttlMs);
      const k = jwksKey(args.issuer);
      await this.#redis.set(k, JSON.stringify(args.jwks), "PX", ttlMs);
    },

    get: async <T = unknown>(issuer: string): Promise<T | null> => {
      const k = jwksKey(issuer);
      const value = await this.#redis.get(k);
      return value === null ? null : (JSON.parse(value) as T);
    },
  };

  // -------------------------------------------------------------------------
  // Coalescer namespace — exposed both raw and via the high-level coalesce()
  // -------------------------------------------------------------------------

  /**
   * Per-user request coalescer (D9b slow path). Within `ttl_ms` the same
   * (user, action, resource) tuple will share ONE inner producer call across
   * concurrent callers in the same process. Cross-process coalescing across
   * the cluster uses the Valkey key as a leader-election token.
   *
   * NOTE: For cross-process leader election, the in-process @sitidos/coalescer
   * package is the canonical primitive. This method is the convenience wrapper
   * for the common 1-process-many-async-callers case.
   */
  async coalesce<T>(
    args: { key: string; ttl_ms: number },
    producer: () => Promise<T>,
  ): Promise<T> {
    assertTtl(args.ttl_ms);
    // The Valkey key acts as a "claim" marker so we have a record of in-flight
    // coalesced work for observability. The actual deduplication is in-process
    // via @sitidos/coalescer (consumers compose the two).
    const k = `coalescer:${this.#service}:${args.key}`;
    if (!/^[A-Za-z0-9._\-@:]{1,256}$/.test(k)) {
      throw new TypeError(`[valkey-client] illegal coalescer key: ${k}`);
    }
    await this.#redis.set(k, "1", "PX", args.ttl_ms, "NX");
    return await producer();
  }

  /** Lower-level access for @sitidos/coalescer to compose the leader token. */
  readonly coalescerLow = {
    /** Attempt to acquire the coalescer token. Returns true if acquired. */
    tryAcquire: async (args: {
      userId: string;
      action: string;
      resourceId: string;
      ttl_ms: number;
    }): Promise<boolean> => {
      assertTtl(args.ttl_ms);
      const k = coalescerKey({
        userId: args.userId,
        action: args.action,
        resourceId: args.resourceId,
      });
      const result = await this.#redis.set(k, "1", "PX", args.ttl_ms, "NX");
      return result === "OK";
    },
  };

  // -------------------------------------------------------------------------
  // Revalidation cursor + pub/sub
  // -------------------------------------------------------------------------

  readonly revalidate = {
    /** Persist the latest cursor for a tag. TTL hard-capped to 24h. */
    setCursor: async (args: {
      tag: string;
      cursor: string;
      ttl_ms?: number;
    }): Promise<void> => {
      const ttlMs = args.ttl_ms ?? MAX_TTL_MS;
      assertTtl(ttlMs);
      const k = revalidateCursorKey(args.tag);
      await this.#redis.set(k, args.cursor, "PX", ttlMs);
    },

    getCursor: async (tag: string): Promise<string | null> => {
      return await this.#redis.get(revalidateCursorKey(tag));
    },

    /**
     * Publish a fire-and-forget revalidation event. Per F8 spec: no retention,
     * no consumer group, no ack. If F17 is offline, the event is lost.
     */
    publish: async (event: RevalidationEvent): Promise<void> => {
      const payload = encodeRevalidationEvent(event);
      await this.#redis.publish(REVALIDATE_PUBSUB_CHANNEL, payload);
    },

    /**
     * Subscribe to the revalidation bus. Returns a function that unsubscribes
     * and disconnects the dedicated subscriber connection. F17 owns the
     * canonical subscriber; other consumers should think hard before adding one.
     */
    subscribe: async (
      onEvent: (event: RevalidationEvent) => void | Promise<void>,
      onError?: (err: Error) => void,
    ): Promise<() => Promise<void>> => {
      // Pub/sub requires a dedicated connection per iovalkey docs.
      const sub = this.#redis.duplicate();
      sub.on("message", (_channel, payload) => {
        try {
          const event = decodeRevalidationEvent(payload);
          void onEvent(event);
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      });
      await sub.subscribe(REVALIDATE_PUBSUB_CHANNEL);
      return async () => {
        await sub.unsubscribe(REVALIDATE_PUBSUB_CHANNEL);
        await sub.quit();
      };
    },
  };
}

function assertTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`[valkey-client] ttl_ms must be positive, got ${ttlMs}`);
  }
  if (ttlMs > MAX_TTL_MS) {
    throw new TypeError(
      `[valkey-client] ttl_ms ${ttlMs} exceeds 24h hard cap (F8 prohibition)`,
    );
  }
}

export type { RatelimitWindow };
