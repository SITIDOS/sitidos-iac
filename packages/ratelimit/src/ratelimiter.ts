/**
 * F8 — Sliding-window rate limiter.
 *
 * Strategy: fixed-window INCR-then-EXPIRE counter per (service, principal,
 * window). Simple, sub-5ms, and adequate for the per-route quotas F3 needs.
 * Upgrades to a true sliding-window log are possible without changing the
 * public API.
 *
 * Failure mode: if the Valkey bump rejects, the limiter logs the degradation
 * via the optional `onDegraded` hook and FAILS OPEN. This is acceptable for
 * F3's per-route rate-limit (a brief loss of rate-limit is preferable to a
 * service outage), but is NOT acceptable on the auth path — F4's PDP MUST
 * NOT use this limiter as its sole gate.
 */

import type { ValkeyClient } from "@sitidos/valkey-client";
import type { RatelimitWindow } from "@sitidos/valkey-client";

export interface RatelimitBudget {
  /** Max requests allowed in the window. */
  max: number;
  /** Window label (only fixed values per @sitidos/valkey-client). */
  window: RatelimitWindow;
}

export interface RatelimiterOptions {
  /** Pre-built valkey client; one per service is the norm. */
  valkey: ValkeyClient;
  /**
   * Optional hook called when the underlying bump fails. The limiter then
   * fails OPEN. F10 wires this to its degraded-mode counter.
   */
  onDegraded?: (err: Error, context: { principal: string; window: RatelimitWindow }) => void;
}

export interface RatelimitDecision {
  /** True if the request is allowed. */
  allowed: boolean;
  /** Count after the bump (or the cached count if degraded). */
  count: number;
  /** Configured budget for this check. */
  budget: RatelimitBudget;
  /** Approximate ms until the window rolls over (best-effort). */
  resetMs: number;
  /** True if Valkey was unreachable and the limiter failed open. */
  degraded: boolean;
}

export class Ratelimiter {
  readonly #valkey: ValkeyClient;
  readonly #onDegraded: RatelimiterOptions["onDegraded"];

  constructor(opts: RatelimiterOptions) {
    this.#valkey = opts.valkey;
    this.#onDegraded = opts.onDegraded;
  }

  /**
   * Bump the counter for `principal` under `budget`. Returns a decision
   * including whether the request is allowed.
   */
  async check(args: {
    principal: string;
    budget: RatelimitBudget;
  }): Promise<RatelimitDecision> {
    const { principal, budget } = args;
    if (budget.max <= 0) {
      throw new RangeError(`[ratelimit] budget.max must be positive, got ${budget.max}`);
    }
    try {
      const { count, windowMs } = await this.#valkey.ratelimit.bump({
        key: principal,
        window: budget.window,
      });
      return {
        allowed: count <= budget.max,
        count,
        budget,
        resetMs: windowMs,
        degraded: false,
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.#onDegraded?.(e, { principal, window: budget.window });
      // Fail OPEN — see file header for the why and the carve-out.
      return {
        allowed: true,
        count: 0,
        budget,
        resetMs: 0,
        degraded: true,
      };
    }
  }
}
