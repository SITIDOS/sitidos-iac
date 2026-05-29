import { describe, it, expect, vi } from "vitest";
import { CloudflareClient, OutOfZoneError, TagLimitError, CloudflareApiError } from "./index.js";

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, result, errors: [], messages: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const err = (status: number, errors: unknown[]) =>
  new Response(JSON.stringify({ success: false, errors }), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("CloudflareClient.createOrgDNS", () => {
  it("rejects empty slug (would yield apex)", async () => {
    const cf = new CloudflareClient({
      zoneId: "zone",
      dnsWriterToken: "t",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(cf.createOrgDNS({ org_slug: "" })).rejects.toBeInstanceOf(OutOfZoneError);
  });

  it("requires dnsWriterToken", async () => {
    const cf = new CloudflareClient({ zoneId: "zone" });
    await expect(cf.createOrgDNS({ org_slug: "acme" })).rejects.toThrow(/dnsWriterToken/);
  });

  it("creates a proxied CNAME by default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({ id: "r1", type: "CNAME", name: "acme.sitidos.app", content: "tunnel.sitidos.app", proxied: true }),
    );
    const cf = new CloudflareClient({
      zoneId: "zone",
      dnsWriterToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const rec = await cf.createOrgDNS({ org_slug: "acme" });
    expect(rec.name).toBe("acme.sitidos.app");
    expect(rec.proxied).toBe(true);
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.name).toBe("acme.sitidos.app");
    expect(body.proxied).toBe(true);
  });
});

describe("CloudflareClient.purgeCacheByTag", () => {
  it("rejects empty tags", async () => {
    const cf = new CloudflareClient({ zoneId: "zone", cachePurgeToken: "t" });
    await expect(cf.purgeCacheByTag({ tags: [] })).rejects.toThrow(/at least one tag/);
  });

  it("rejects >30 tags", async () => {
    const cf = new CloudflareClient({ zoneId: "zone", cachePurgeToken: "t" });
    const tags = Array.from({ length: 31 }, (_, i) => `t:${i}`);
    await expect(cf.purgeCacheByTag({ tags })).rejects.toBeInstanceOf(TagLimitError);
  });

  it("calls purge_cache with the tag list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ id: "purge-1" }));
    const cf = new CloudflareClient({
      zoneId: "zone",
      cachePurgeToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await cf.purgeCacheByTag({ tags: ["org:acme:catalog"] });
    expect(out.id).toBe("purge-1");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/zones/zone/purge_cache");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ tags: ["org:acme:catalog"] });
  });
});

describe("CloudflareClient error handling", () => {
  it("wraps CF API errors without leaking tokens", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(err(403, [{ code: 10000, message: "forbidden" }]));
    const cf = new CloudflareClient({
      zoneId: "zone",
      cachePurgeToken: "supersecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await cf.purgeCacheByTag({ tags: ["x"] });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudflareApiError);
      expect(String(e)).not.toContain("supersecret");
    }
  });
});
