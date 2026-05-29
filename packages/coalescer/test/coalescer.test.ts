import { describe, expect, it, vi } from "vitest";
import { Coalescer } from "../src/coalescer.js";

describe("Coalescer", () => {
  it("shares one producer call across concurrent callers", async () => {
    const c = new Coalescer({ sweepIntervalMs: null });
    const producer = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });
    const [a, b, d] = await Promise.all([
      c.run("k", producer),
      c.run("k", producer),
      c.run("k", producer),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(d).toBe(42);
    expect(producer).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("serves fresh value within TTL without re-invoking producer", async () => {
    let t = 1_000;
    const c = new Coalescer({ sweepIntervalMs: null, now: () => t });
    const producer = vi.fn(async () => "v");
    expect(await c.run("k", producer, { ttlMs: 100 })).toBe("v");
    t = 1_050; // still inside the window
    expect(await c.run("k", producer, { ttlMs: 100 })).toBe("v");
    expect(producer).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("re-invokes producer after TTL expiry (sliding from first call)", async () => {
    let t = 1_000;
    const c = new Coalescer({ sweepIntervalMs: null, now: () => t });
    const producer = vi.fn(async () => "v");
    await c.run("k", producer, { ttlMs: 100 });
    t = 1_200; // window elapsed
    await c.run("k", producer, { ttlMs: 100 });
    expect(producer).toHaveBeenCalledTimes(2);
    c.dispose();
  });

  it("drops failed entries immediately (no negative caching, D9b fails CLOSED)", async () => {
    const c = new Coalescer({ sweepIntervalMs: null });
    const producer = vi
      .fn()
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce("recovered");
    await expect(c.run("k", producer)).rejects.toThrow("upstream down");
    // After failure, next call re-attempts immediately.
    expect(await c.run("k", producer)).toBe("recovered");
    expect(producer).toHaveBeenCalledTimes(2);
    c.dispose();
  });

  it("rejects TTLs above 5s (D9b 100ms target; 5s is the absolute ceiling)", () => {
    expect(() => new Coalescer({ defaultTtlMs: 5_001 })).toThrow(/defaultTtlMs/);
    const c = new Coalescer({ sweepIntervalMs: null });
    return expect(c.run("k", async () => 0, { ttlMs: 5_001 })).rejects.toThrow(
      /ttlMs/,
    );
  });

  it("sweep() evicts expired entries", async () => {
    let t = 1_000;
    const c = new Coalescer({ sweepIntervalMs: null, now: () => t });
    await c.run("a", async () => 1, { ttlMs: 50 });
    await c.run("b", async () => 2, { ttlMs: 50 });
    expect(c.size).toBe(2);
    t = 2_000;
    c.sweep();
    expect(c.size).toBe(0);
    c.dispose();
  });

  it("invalidate() drops a single key", async () => {
    const c = new Coalescer({ sweepIntervalMs: null });
    await c.run("k", async () => 1, { ttlMs: 1_000 });
    expect(c.size).toBe(1);
    c.invalidate("k");
    expect(c.size).toBe(0);
    c.dispose();
  });
});
