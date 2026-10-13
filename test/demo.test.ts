import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The simulator schedules with window.setTimeout; give it a window in node.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

const { DemoSim } = await import("../web/src/demo/sim");

interface Radar { pairs: { a: string; b: string; severity: string; conflicts: string[] }[]; baseConflicts: Record<string, string[]> }

describe("demo simulator (uses Octave's real scoring engines)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settle = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  /** request() simulates network latency with a timer; advance past it. */
  const call = async <T,>(sim: InstanceType<typeof DemoSim>, path: string, init?: { method?: string; body?: unknown }) => {
    const p = sim.request<T>(path, init);
    await vi.advanceTimersByTimeAsync(300);
    return p;
  };

  it("tells the full story: conflict, base drift, risky diff first, ranked tournament", async () => {
    const sim = new DemoSim();
    await settle(15000);
    const state = await call<{ workspaces: { id: string; name: string }[] }>(sim, "/api/state");
    const id = (n: string) => state.workspaces.find((w) => w.name === n)!.id;

    const radar = await call<Radar>(sim, "/api/projects/demo/radar");
    const pair = radar.pairs.find((p) => [p.a, p.b].includes(id("bulk-discounts")) && [p.a, p.b].includes(id("discount-refactor")))!;
    expect(pair).toMatchObject({ severity: "conflict", conflicts: ["src/cart.ts"] });
    const taxPair = radar.pairs.find((p) => [p.a, p.b].includes(id("bulk-discounts")) && [p.a, p.b].includes(id("tax-by-region")))!;
    expect(taxPair.severity).toBe("overlap");
    expect(radar.baseConflicts[id("session-hardening")]).toEqual(["src/auth/session.ts"]);

    const tri = await call<{ queue: { workspaceId: string; risk: { level: string } }[] }>(sim, "/api/projects/demo/triage");
    expect(tri.queue[0]).toMatchObject({ workspaceId: id("session-hardening"), risk: { level: "high" } });

    const t = (await call<{ tournaments: { status: string; winner?: string; entrants: { verify?: { passed: boolean } }[] }[] }>(sim, "/api/state")).tournaments[0];
    expect(t.status).toBe("done");
    expect(t.entrants[0].verify?.passed).toBe(true);
    expect(t.winner).toBeTruthy();
  });

  it("a heads-up makes the agent move its change and the conflict disappears", async () => {
    const sim = new DemoSim();
    await settle(12000);
    const state = await call<{ workspaces: { id: string; name: string }[] }>(sim, "/api/state");
    const refactor = state.workspaces.find((w) => w.name === "discount-refactor")!.id;
    const conflicts = async () => (await call<Radar>(sim, "/api/projects/demo/radar")).pairs.filter((p) => p.severity === "conflict").length;
    expect(await conflicts()).toBe(1);
    await call(sim, `/api/workspaces/${refactor}/input`, { body: { text: "Heads-up from Octave" } });
    await settle(6000);
    expect(await conflicts()).toBe(0);
    const diff = await call<{ files: { path: string }[] }>(sim, `/api/workspaces/${refactor}/diff`);
    expect(diff.files.map((f) => f.path)).toEqual(["src/discounts.ts"]);
  });

  it("refuses things that need a real machine, with a clear reason", async () => {
    const sim = new DemoSim();
    const p = sim.request("/api/projects", { body: { path: "/etc" } });
    const assertion = expect(p).rejects.toThrow(/Install Octave/);
    await settle(500);
    await assertion;
  });
});
