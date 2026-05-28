import { describe, it, expect, vi } from "vitest";
import { VercelAliasClient, OutOfZoneError, VercelApiError } from "./index.js";

const ok = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("VercelAliasClient.createOrgAlias", () => {
  it("rejects empty slug (would yield apex)", async () => {
    const cli = new VercelAliasClient({
      token: "t",
      projectId: "p",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    // Empty slug yields ".sitidos.app" → assertInZone treats apex/non-suffix as out-of-zone.
    await expect(cli.createOrgAlias({ org_slug: "" })).rejects.toBeInstanceOf(OutOfZoneError);
  });

  it("returns alreadyExisted=true on 409 domain_already_in_use", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "domain_already_in_use", message: "x" } }), {
        status: 409,
      }),
    );
    const cli = new VercelAliasClient({
      token: "t",
      projectId: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await cli.createOrgAlias({ org_slug: "acme" });
    expect(r).toEqual({ hostname: "acme.sitidos.app", alreadyExisted: true });
  });

  it("creates a new alias on 201", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ name: "acme.sitidos.app" }));
    const cli = new VercelAliasClient({
      token: "t",
      projectId: "proj_123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await cli.createOrgAlias({ org_slug: "acme" });
    expect(r).toEqual({ hostname: "acme.sitidos.app", alreadyExisted: false });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/v10/projects/proj_123/domains");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ name: "acme.sitidos.app" });
  });

  it("appends teamId to URL when configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ name: "acme.sitidos.app" }));
    const cli = new VercelAliasClient({
      token: "t",
      projectId: "p",
      teamId: "team_abc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await cli.createOrgAlias({ org_slug: "acme" });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("teamId=team_abc");
  });

  it("does not leak the token in error messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }),
    );
    const cli = new VercelAliasClient({
      token: "supersecret-vercel-token",
      projectId: "p",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await cli.createOrgAlias({ org_slug: "acme" });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(VercelApiError);
      expect(String(e)).not.toContain("supersecret-vercel-token");
    }
  });
});

describe("OutOfZoneError", () => {
  it("is throwable", () => {
    expect(() => {
      throw new OutOfZoneError("acme.evil.com");
    }).toThrow(/sitidos.app/);
  });
});
