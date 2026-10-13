import { describe, it, expect } from "vitest";
import net from "node:net";
import { PortAllocator, portEnv, renderEnvFile, isPortFree } from "../server/ports";

describe("port allocator", () => {
  it("skips reserved blocks and blocks containing a busy port", async () => {
    const busy = new Set([4125]);
    const alloc = new PortAllocator(4100, 10, 50, async (p) => !busy.has(p));
    const b1 = await alloc.allocate([]);
    expect(b1.base).toBe(4100);
    const b2 = await alloc.allocate([b1]);
    expect(b2.base).toBe(4110);
    const b3 = await alloc.allocate([b1, b2]);
    expect(b3.base).toBe(4130); // 4120 block contains busy 4125
    expect(b3.ports).toHaveLength(10);
  });

  it("probe sees a real listener", async () => {
    const srv = net.createServer().listen(0);
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as net.AddressInfo).port;
    expect(await isPortFree(port)).toBe(false);
    srv.close();
  });

  it("renders env", () => {
    const env = portEnv({ base: 4100, ports: [4100, 4101] });
    expect(env).toEqual({ PORT: "4100", OCTAVE_PORT_0: "4100", OCTAVE_PORT_1: "4101" });
    expect(renderEnvFile(env)).toContain("PORT=4100\n");
  });
});

describe("agent environment", () => {
  it("strips package-manager and octave-internal variables", async () => {
    const { cleanEnv } = await import("../server/pty");
    const env = cleanEnv({ PATH: "/bin", HOME: "/h", npm_config_prefix: "/x", npm_lifecycle_event: "start", INIT_CWD: "/y", NODE_ENV: "production", OCTAVE_HOME: "/o", pnpm_config_foo: "1" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});
