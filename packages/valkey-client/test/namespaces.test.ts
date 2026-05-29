import { describe, expect, it } from "vitest";
import {
  MAX_TTL_MS,
  REVALIDATE_PUBSUB_CHANNEL,
  coalescerKey,
  jwksKey,
  ratelimitKey,
  revalidateCursorKey,
} from "../src/namespaces.js";
import {
  decodeRevalidationEvent,
  encodeRevalidationEvent,
  MAX_TAGS_PER_EVENT,
  isRevalidationEventV1,
} from "../src/pubsub.js";

describe("namespaces — key construction", () => {
  it("ratelimitKey emits the spec'd format", () => {
    expect(
      ratelimitKey({ service: "rpc-backplane", principalId: "user_123", window: "1m" }),
    ).toBe("ratelimit:rpc-backplane:user_123:1m");
  });

  it("jwksKey emits jwks:<issuer>", () => {
    expect(jwksKey("https://sitidos.us.auth0.com")).toBe(
      "jwks:https://sitidos.us.auth0.com",
    );
  });

  it("coalescerKey emits coalescer:<user>:<action>:<resource>", () => {
    expect(
      coalescerKey({ userId: "u_1", action: "read", resourceId: "doc_42" }),
    ).toBe("coalescer:u_1:read:doc_42");
  });

  it("revalidateCursorKey emits revalidate:cursor:<tag>", () => {
    expect(revalidateCursorKey("ws:abc:catalog")).toBe(
      "revalidate:cursor:ws:abc:catalog",
    );
  });

  it("exposes the pub/sub channel name as a constant", () => {
    expect(REVALIDATE_PUBSUB_CHANNEL).toBe("revalidate:bus");
  });

  it("MAX_TTL_MS is 24 hours", () => {
    expect(MAX_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("namespaces — segment validation", () => {
  it("rejects whitespace in segments", () => {
    expect(() =>
      ratelimitKey({ service: "rpc backplane", principalId: "x", window: "1m" }),
    ).toThrow(/illegal key segment/);
  });

  it("rejects empty segments", () => {
    expect(() =>
      coalescerKey({ userId: "", action: "read", resourceId: "x" }),
    ).toThrow(/illegal key segment/);
  });

  it("rejects colon-injection in non-tag segments", () => {
    expect(() => jwksKey("attacker:injected")).toThrow(/illegal jwks issuer/);
  });

  it("allows colons in tag segments (D7 taxonomy)", () => {
    expect(() => revalidateCursorKey("org:acme:catalog")).not.toThrow();
  });

  it("rejects oversize segments (DoS guard)", () => {
    expect(() => jwksKey("https://" + "a".repeat(600))).toThrow(/illegal jwks issuer/);
  });
});

describe("pubsub — revalidation envelope", () => {
  const sample = {
    v: 1 as const,
    event_id: "01HZK000000000000000000000",
    source: "iceberg-writer",
    emitted_at: "2026-05-28T12:00:00Z",
    tags: ["ws:abc:catalog", "org:acme"],
  };

  it("encodes and decodes a v1 envelope", () => {
    const wire = encodeRevalidationEvent(sample);
    expect(decodeRevalidationEvent(wire)).toEqual(sample);
  });

  it("rejects empty tag list", () => {
    expect(() =>
      encodeRevalidationEvent({ ...sample, tags: [] }),
    ).toThrow(/at least one tag/);
  });

  it("rejects > 128 tags (D7 Vercel ceiling)", () => {
    const tags = Array.from({ length: MAX_TAGS_PER_EVENT + 1 }, (_, i) => `ws:x:${i}`);
    expect(() => encodeRevalidationEvent({ ...sample, tags })).toThrow(/128 tag cap/);
  });

  it("rejects malformed payload on decode", () => {
    expect(() => decodeRevalidationEvent('{"v":2,"foo":"bar"}')).toThrow(
      /not a v1 revalidation event/,
    );
  });

  it("type-guards v1 events", () => {
    expect(isRevalidationEventV1(sample)).toBe(true);
    expect(isRevalidationEventV1({ v: 1 })).toBe(false);
    expect(isRevalidationEventV1(null)).toBe(false);
  });
});
