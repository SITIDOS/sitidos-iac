/**
 * F8 — @sitidos/coalescer
 *
 * In-process per-key request coalescer. Within a sliding window, concurrent
 * callers for the same key share ONE inner producer call.
 *
 * Used by F4 (D9b slow path) to deduplicate upstream permission checks within
 * a 100ms window per (user, action, resource) tuple.
 *
 * Cross-process coalescing across the cluster is the caller's responsibility;
 * compose with `@sitidos/valkey-client`'s `coalescerLow.tryAcquire()` to use
 * the Valkey key as a leader-election token across replicas.
 */

export { Coalescer } from "./coalescer.js";
export type { CoalescerOptions } from "./coalescer.js";
