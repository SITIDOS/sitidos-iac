import { describe, expect, it, vi } from "vitest";
import { Ratelimiter } from "../src/ratelimiter.js";

function fakeValkey(bumpImpl: () => Promise<{ count: number; windowMs: number }>) {
  return {
    ratelimit: { bump: vi.fn(bumpImpl), peek: vi.fn() },
  } as unknown as Parameters<typeof Ratelimiter>[0] extends never
    ? never
    : ConstructorParameters<typeof Ratelimiter>[0]["valkey"];
}

describe("Ratelimiter", () => {
  it("allows when count <= max", async () => {
    const valkey = fakeValkey(async () => ({ count: 3, windowMs: 60_000 }));
    const rl = new Ratelimiter({ valkey });
    const d = await rl.check({
      principal: "user_1",
      budget: { max: 10, window: "1m" },
    });
    expect(d.allowed).toBe(true);
    expect(d.count).toBe(3);
    expect(d.degraded).toBe(false);
    expect(d.resetMs).toBe(60_000);
  });

  it("denies when count > max", async () => {
    const valkey = fakeValkey(async () => ({ count: 11, windowMs: 60_000 }));
    const rl = new Ratelimiter({ valkey });
    const d = await rl.check({
      principal: "user_1",
      budget: { max: 10, window: "1m" },
    });
    expect(d.allowed).toBe(false);
  });

  it("fails OPEN with degraded=true when valkey throws", async () => {
    const valkey = fakeValkey(async () => {
      throw new Error("ECONNREFUSED");
    });
    const onDegraded = vi.fn();
    const rl = new Ratelimiter({ valkey, onDegraded });
    const d = await rl.check({
      principal: "user_1",
      budget: { max: 10, window: "1m" },
    });
    expect(d.allowed).toBe(true);
    expect(d.degraded).toBe(true);
    expect(onDegraded).toHaveBeenCalledOnce();
  });

  it("rejects non-positive max", async () => {
    const valkey = fakeValkey(async () => ({ count: 0, windowMs: 0 }));
    const rl = new Ratelimiter({ valkey });
    await expect(
      rl.check({ principal: "u", budget: { max: 0, window: "1m" } }),
    ).rejects.toThrow(/budget.max/);
  });
});
