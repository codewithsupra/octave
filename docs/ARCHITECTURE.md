# Octave architecture and design decisions

This is the "why" behind the code: the decisions, the trade-offs and what would change at a larger scale.

## System overview

```
browser: React + xterm.js                       agent CLIs (claude, codex, cursor-agent, …)
  │ REST /api/*                                    │ run inside node-pty, one per worktree
  │ WebSocket /ws/events  (state push)             │ lifecycle hooks → octave-hook.sh
  │ WebSocket /ws/term/:id (terminal I/O)          ▼
  ▼                                         POST /api/hooks/:id  (per-workspace secret)
Node.js server (server/app.ts: Express + ws, 127.0.0.1 by default)
  ├─ Gate          Clerk JWT verification + owner lock           server/auth.ts
  ├─ RateLimiter   token buckets for /api and hooks              server/ratelimit.ts
  ├─ Octave        projects, workspaces, radar, triage, tourneys server/octave.ts
  ├─ SessionManager  PTYs, scrollback, hook- or activity-driven status   server/pty.ts
  ├─ git.ts        worktrees, snapshots, diffs, merge-tree       server/git.ts
  ├─ risk.ts / scoring.ts   pure scoring engines (also run in the browser demo)
  └─ Store         ~/.octave/state.json                          server/store.ts
```

## Key mechanisms

### 1. Snapshots: reading an agent's work without touching it

To diff or merge an agent's *uncommitted* work, Octave needs it as a commit. `git add` would modify the agent's index while it works. Instead, `snapshot()` (server/git.ts) does the following:

1. Points `GIT_INDEX_FILE` at a temp file and runs `read-tree HEAD`, `add -A` and `write-tree` there.
2. Runs `commit-tree` with **fixed author and committer dates**.

The real index and files are never touched. Because the dates are fixed, the same content always produces the same SHA, so snapshots are content-addressed. Diff and merge results are cached by SHA, and a radar poll only recomputes the pairs that changed.

### 2. Conflict radar: a real merge, not a guess

For each pair of workspaces that share a file, `git merge-tree --write-tree --name-only` performs a real three-way merge in memory and lists the conflicting paths. Each workspace is also merged against the current base branch, to catch "main moved underneath you". Entrants of the same tournament are skipped, because they're alternatives by design.

### 3. Security model: a server that can spawn shells

The threat is any web page the user visits. It can try to reach `localhost` through DNS rebinding or a cross-site WebSocket. The layers, from outside in:

| Layer | Where | Test |
|---|---|---|
| Bind to `127.0.0.1` unless `OCTAVE_PUBLIC_URL` is set, and refuse to start remote mode without auth | `server/app.ts` | `test/server.test.ts` |
| Reject any request or WebSocket upgrade whose `Host` or `Origin` isn't local | `server/app.ts` | foreign Host / Origin → 403 |
| Clerk JWT verified server-side (signature, expiry, `azp` must be one of our origins) | `server/app.ts`, `@clerk/express` | forged / expired / wrong-origin → 401 |
| WebSockets authenticate with their first message (no headers in the browser API, and no tokens in URLs) | `server/app.ts` | bad token → close 4401 |
| Owner lock: the first account to sign in claims the instance; others get 403 unless allowlisted | `server/auth.ts` | second account → 403 / 4403 |
| Hook callbacks use a per-workspace secret compared in constant time | `server/hooks.ts` | wrong secret → 403 |
| Rate limits: `/api` per client; hooks per workspace; a client is throttled after 20 bad secrets | `server/ratelimit.ts` | brute force → 429 + Retry-After |
| Agent shells get a cleaned environment (no leaked npm/pnpm/yarn/bun variables) | `server/pty.ts` | `test/ports.test.ts` |

### 4. Agent hooks that can never hurt the agent

Claude Code treats a `Stop` hook that exits with code 2 as "keep going". So `octave-hook.sh` is silent, times out after 2 seconds and always exits 0. It's a no-op outside Octave. Once an agent sends its first hook event, hooks own its status. Agents without hooks fall back to activity (terminal output) as the status signal.

## Why state is a JSON file, and what changes for teams

**Today:** Octave is a single-user local tool. Its state is small (projects, workspaces, tournaments; usually under 100 KB), written by one process, and has to survive restarts. `Store` keeps it in memory and persists it with a debounced, atomic write (temp file plus rename). A corrupt file is moved aside instead of crashing the app. A database would add a dependency and an install step with no benefit at this scale.

**For teams (Pro-style multi-user), I'd change:**

1. **Postgres for shared metadata.** That covers orgs, members and roles, projects, workspace records, tournament results and audit logs. Repos and terminals stay on each machine, the same split Superset uses.
2. **Clerk Organizations for roles** (owner, editor, viewer) in place of the single-owner lock, enforced server-side per route.
3. **An event log** (append-only table) instead of whole-state broadcasts, so clients can sync deltas.
4. **Per-host agents.** Each machine runs Octave as a "host" that registers with the control plane over an authenticated outbound connection. That's how remote GPU boxes would work without opening inbound ports.

## Testing strategy

| Layer | Tooling | What it proves |
|---|---|---|
| Unit | Vitest | Pure logic: risk scoring, tournament ranking, hook event mapping, rate limiter, auth gate, demo simulator |
| Integration | Vitest with real git repos, PTYs, sockets and HTTP | Worktrees, snapshots, merge prediction, hooks end to end, and the real HTTP/WebSocket server with real Clerk token verification (networkless `jwtKey` mode) |
| End to end | Playwright (desktop + Pixel 7) | Landing page, code splitting, the full demo story, and no horizontal scroll at phone width |
| Accessibility | axe-core in Playwright | WCAG 2.1 A/AA on the landing page and every demo view |
| Real agents | `npm run smoke:agents` (opt-in; uses your logins and tokens) | Claude Code / Codex / Cursor run headless through Octave and their hooks arrive |

Coverage (`npm run test:coverage`) is enforced in CI: lines ≥ 80%, branches ≥ 70%.

## Known limits

- **Windows:** not supported yet. The integration tests and the hook script assume a POSIX shell.
- **Cursor:** the hook files are generated, but the integration hasn't been run against a real Cursor CLI.
- **Signed-in browser flow:** the server-side auth is tested end to end, but signing in through Clerk's hosted UI isn't automated. That needs a Clerk test user.
