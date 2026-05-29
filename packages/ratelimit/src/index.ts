/**
 * F8 — @sitidos/ratelimit
 *
 * Sliding-window rate limiter for F3 (per-route). Uses the ratelimit
 * namespace of @sitidos/valkey-client. Each route declares a budget
 * (max requests per window). The limiter bumps the counter and returns
 * a decision + remaining quota.
 */

export { Ratelimiter } from "./ratelimiter.js";
export type {
  RatelimiterOptions,
  RatelimitDecision,
  RatelimitBudget,
} from "./ratelimiter.js";
