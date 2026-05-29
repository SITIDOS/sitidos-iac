/**
 * F8 — Pub/Sub spec for the ISR revalidation channel.
 *
 * Channel:           `revalidate:bus`
 * Retention policy:  NONE — fire-and-forget. If F17 is offline, events are lost.
 * Consumer groups:   NONE — broadcast. Every subscriber sees every event.
 *
 * Payload schema is versioned. Producers (F1 Iceberg writer commit hook,
 * F15 parquet-writer, F19 catalog mutations) MUST emit a v1 envelope.
 * Consumers (F17) MUST gracefully ignore unknown future versions.
 */

import { REVALIDATE_PUBSUB_CHANNEL } from "./namespaces.js";

/**
 * Tag taxonomy (D7):
 *   - `ws:${id}:${namespace}`
 *   - `org:${slug}`
 *   - `org:${slug}:catalog`
 *   - `user:${id}:memberships`
 *
 * Hard cap: 128 tags per event (Vercel `revalidateTag` ceiling, D7).
 */
export const MAX_TAGS_PER_EVENT = 128;

export interface RevalidationEventV1 {
  v: 1;
  /** ULID; F17 dedupes against a 60s window of recent ids. */
  event_id: string;
  /** Producer service name, for observability only. */
  source: string;
  /** RFC3339 UTC timestamp. */
  emitted_at: string;
  /** D7 tag taxonomy. Length <= MAX_TAGS_PER_EVENT. */
  tags: string[];
  /** Optional Iceberg snapshot id that triggered this event. */
  iceberg_snapshot_id?: string;
}

export type RevalidationEvent = RevalidationEventV1;

export function isRevalidationEventV1(value: unknown): value is RevalidationEventV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.event_id === "string" &&
    typeof v.source === "string" &&
    typeof v.emitted_at === "string" &&
    Array.isArray(v.tags) &&
    v.tags.every((t) => typeof t === "string") &&
    v.tags.length <= MAX_TAGS_PER_EVENT
  );
}

export function encodeRevalidationEvent(event: RevalidationEventV1): string {
  if (event.tags.length === 0) {
    throw new TypeError("[valkey-client] revalidation event must carry at least one tag");
  }
  if (event.tags.length > MAX_TAGS_PER_EVENT) {
    throw new TypeError(
      `[valkey-client] revalidation event exceeds ${MAX_TAGS_PER_EVENT} tag cap (D7)`,
    );
  }
  return JSON.stringify(event);
}

export function decodeRevalidationEvent(payload: string): RevalidationEventV1 {
  const parsed: unknown = JSON.parse(payload);
  if (!isRevalidationEventV1(parsed)) {
    throw new TypeError("[valkey-client] payload is not a v1 revalidation event");
  }
  return parsed;
}

export { REVALIDATE_PUBSUB_CHANNEL };
