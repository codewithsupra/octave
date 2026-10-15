import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import WebSocket from "ws";
import { createOctaveServer, type OctaveServer } from "../server/app";
import { RateLimiter } from "../server/ratelimit";
import { makeRepo, tmp } from "./helpers";

/**
 * Boots the real HTTP + WebSocket server. Clerk's verifyToken runs for real in
 * networkless mode (jwtKey): signatures, expiry and authorized party are all
 * checked by Clerk's code, against a key pair generated here.
 */
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(claims: Record<string, unknown>, key = keys.privateKey) {
  const head = b64({ alg: "RS256", typ: "JWT", kid: "ins_test" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ iat: now, nbf: now - 5, exp: now + 60, iss: "https://test.clerk.accounts.dev", sid: "sess_1", ...claims });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

let app: OctaveServer;
let base: string;
let origin: string;
const tok = (sub: string, extra: Record<string, unknown> = {}) => jwt({ sub, azp: origin, ...extra });
const get = (path: string, token?: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

beforeAll(async () => {
  app = createOctaveServer({ home: tmp(), port: 0, clerk: { jwtKey: pem, publishableKey: "pk_test_x" }, distDir: "/nonexistent" });
  const port = await app.listen();
  base = `http://127.0.0.1:${port}`;
  origin = `http://localhost:${port}`;
});
afterAll(() => app.close());

describe("real server: Clerk auth on HTTP", () => {
  it("advertises auth publicly but gates everything else", async () => {
    expect(await (await get("/api/config")).json()).toEqual({ authEnabled: true, publishableKey: "pk_test_x" });
    expect((await get("/api/state")).status).toBe(401);
  });

  it("rejects forged, expired and wrong-origin tokens", async () => {
    expect((await get("/api/state", jwt({ sub: "user_alice", azp: origin }, other.privateKey))).status).toBe(401);
    expect((await get("/api/state", tok("user_alice", { exp: Math.floor(Date.now() / 1000) - 120 }))).status).toBe(401);
    expect((await get("/api/state", tok("user_alice", { azp: "https://evil.example" }))).status).toBe(401);
    expect(app.store.state.owner).toBeUndefined(); // none of those could claim the instance
  });

  it("first valid user claims the instance; a second account is refused", async () => {
    const r = await get("/api/me", tok("user_alice"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ userId: "user_alice", owner: true });
    expect((await get("/api/state", tok("user_alice"))).status).toBe(200);
    const bob = await get("/api/state", tok("user_bob"));
    expect(bob.status).toBe(403);
    expect((await bob.json()).error).toMatch(/belongs to another account/);
  });

  it("blocks DNS rebinding (foreign Host) and cross-site requests (foreign Origin)", async () => {
    const t = tok("user_alice");
    // fetch() won't let us set Host; use a raw request.
    const raw = await new Promise<number>((resolve) => {
      const u = new URL(base);
      import("node:http").then(({ request }) =>
        request({ host: u.hostname, port: u.port, path: "/api/state", headers: { host: "evil.example", authorization: `Bearer ${t}` } }, (res) => resolve(res.statusCode!)).end(),
      );
    });
    expect(raw).toBe(403);
    expect((await get("/api/state", t, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("real server: WebSocket auth handshake", () => {
  const open = (token: string | null) =>
    new Promise<{ msgs: string[]; code: number }>((resolve) => {
      const ws = new WebSocket(base.replace("http", "ws") + "/ws/events");
      const msgs: string[] = [];
      ws.on("open", () => ws.send(JSON.stringify({ t: "auth", token })));
      ws.on("message", (m) => {
        msgs.push(JSON.parse(String(m)).t ?? JSON.parse(String(m)).type);
        if (msgs.includes("state")) ws.close(1000);
      });
      ws.on("close", (code) => resolve({ msgs, code }));
    });

  it("owner gets state only after authenticating", async () => {
    expect(await open(tok("user_alice"))).toEqual({ msgs: ["authed", "state"], code: 1000 });
  });
  it("bad token closes with 4401 and leaks nothing", async () => {
    expect(await open("garbage")).toEqual({ msgs: [], code: 4401 });
  });
  it("another account closes with 4403", async () => {
    expect(await open(tok("user_bob"))).toEqual({ msgs: [], code: 4403 });
  });
});

describe("real server: agent hooks + rate limits", () => {
  it("accepts a hook with the workspace secret and updates status", async () => {
    const t = tok("user_alice");
    const project = await (await fetch(base + "/api/projects", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ path: makeRepo() }) })).json();
    const ws = await (await fetch(base + "/api/workspaces", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, agent: "custom:sleep 20", bootstrap: false }) })).json();
    const secret = app.store.workspace(ws.id).hookToken!;
    const hook = (auth: string) =>
      fetch(`${base}/api/hooks/${ws.id}`, {
        method: "POST",
        headers: { authorization: auth, "x-octave-agent": "claude", "content-type": "application/json" },
        body: JSON.stringify({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow Bash?" }),
      });
    expect((await hook(`Bearer ${secret}`)).status).toBe(204);
    expect(app.octave.sessions.statuses()[ws.id]).toMatchObject({ status: "attention", detail: "Allow Bash?", source: "hooks" });

    // Brute forcing the secret: 20 wrong guesses, then the client is throttled.
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await hook("Bearer wrong")).status);
    expect(codes.slice(0, 20).every((c) => c === 403)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
    const throttled = await hook(`Bearer ${secret}`);
    expect(throttled.status).toBe(429); // even the right secret waits once a client is throttled
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("rate limiter", () => {
  it("allows a burst, then refills at the configured rate", () => {
    let now = 0;
    const rl = new RateLimiter(3, 60, () => now); // 3 burst, 1 per second
    expect([rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([0, 0, 0]);
    expect(rl.take("a")).toBe(1);
    expect(rl.take("b")).toBe(0); // keys are independent
    now += 1000;
    expect(rl.blocked("a")).toBe(0);
    expect(rl.take("a")).toBe(0);
    expect(rl.blocked("a")).toBeGreaterThan(0);
    now += 60_000;
    expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([0, 0, 0, 1]); // capped at capacity
  });
});
