import { describe, it, expect } from "vitest";
import { Gate, tokenFrom } from "../server/auth";
import { Store } from "../server/store";
import { tmp } from "./helpers";

const verify = async (t: string) => (t.startsWith("tok-") ? { userId: t.slice(4) } : null);

describe("auth gate", () => {
  it("is open when Clerk isn't configured (local mode)", async () => {
    const g = new Gate(new Store(tmp()), null);
    expect(g.enabled).toBe(false);
    expect(await g.check(undefined)).toEqual({ ok: true, userId: null });
  });

  it("rejects missing and invalid tokens", async () => {
    const g = new Gate(new Store(tmp()), verify);
    expect(await g.check(null)).toMatchObject({ ok: false, status: 401 });
    expect(await g.check("garbage")).toMatchObject({ ok: false, status: 401 });
    const throwing = new Gate(new Store(tmp()), async () => { throw new Error("jwks down"); });
    expect(await throwing.check("tok-a")).toMatchObject({ ok: false, status: 401 });
  });

  it("first account claims the instance; others are refused", async () => {
    const store = new Store(tmp());
    const g = new Gate(store, verify);
    expect(await g.check("tok-alice")).toEqual({ ok: true, userId: "alice" });
    expect(store.state.owner?.userId).toBe("alice");
    expect(await g.check("tok-alice")).toEqual({ ok: true, userId: "alice" });
    expect(await g.check("tok-mallory")).toMatchObject({ ok: false, status: 403 });
  });

  it("owner survives a restart and allowlisted users get in", async () => {
    const home = tmp();
    const s1 = new Store(home);
    await new Gate(s1, verify).check("tok-alice");
    s1.flush();
    const g2 = new Gate(new Store(home), verify, ["bob"]);
    expect(await g2.check("tok-mallory")).toMatchObject({ status: 403 });
    expect(await g2.check("tok-bob")).toEqual({ ok: true, userId: "bob" });
  });

  it("extracts tokens from bearer header or __session cookie", () => {
    expect(tokenFrom({ authorization: "Bearer abc" })).toBe("abc");
    expect(tokenFrom({ cookie: "x=1; __session=jwt%2Evalue; y=2" })).toBe("jwt.value");
    expect(tokenFrom({ cookie: "__session_xyz=nope" })).toBeNull();
    expect(tokenFrom({})).toBeNull();
  });
});
