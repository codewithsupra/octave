import type { IncomingHttpHeaders } from "node:http";
import type { Store } from "./store";

export type Verify = (token: string) => Promise<{ userId: string } | null>;

export type GateResult =
  | { ok: true; userId: string | null }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Who may drive this Octave. Signing in to Clerk isn't enough: this server
 * spawns shells on the owner's machine, so the first account to sign in claims
 * the instance and every other account is refused, unless it's listed in
 * OCTAVE_ALLOWED_USERS (comma-separated Clerk user ids).
 */
export class Gate {
  constructor(
    private store: Store,
    private verify: Verify | null,
    private allowed: string[] = [],
  ) {}

  get enabled(): boolean {
    return this.verify !== null;
  }

  async check(token: string | null | undefined): Promise<GateResult> {
    if (!this.verify) return { ok: true, userId: null };
    if (!token) return { ok: false, status: 401, error: "Sign in to use Octave" };
    let claims: { userId: string } | null = null;
    try {
      claims = await this.verify(token);
    } catch {
      claims = null;
    }
    if (!claims?.userId) return { ok: false, status: 401, error: "Your session expired. Sign in again." };

    const { userId } = claims;
    const owner = this.store.state.owner;
    if (!owner) {
      this.store.update((s) => (s.owner = { userId, claimedAt: Date.now() }));
      return { ok: true, userId };
    }
    if (owner.userId === userId || this.allowed.includes(userId)) return { ok: true, userId };
    return {
      ok: false,
      status: 403,
      error: "This Octave belongs to another account. Ask its owner to add your user id to OCTAVE_ALLOWED_USERS.",
    };
  }
}

/** Bearer header first, then Clerk's same-site `__session` cookie. */
export function tokenFrom(headers: IncomingHttpHeaders): string | null {
  const auth = headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const cookie = headers.cookie ?? "";
  const m = cookie.match(/(?:^|;\s*)__session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
