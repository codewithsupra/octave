/**
 * Seeds a running Octave server with a demo repo and scripted "agents" so every
 * feature can be seen without any API keys:
 *   npm start   (in one terminal)
 *   npm run demo
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = `http://localhost:${process.env.OCTAVE_PORT ?? 7420}`;
const dir = process.env.DEMO_DIR ?? path.join(os.tmpdir(), "octave-demo-shop");

const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "demo-shop", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  ".gitignore": "node_modules/\n.env\n",
  "README.md": "# demo-shop\n\nA tiny store used to demo Octave.\n",
  "src/cart.js": `export function subtotal(items) {
  return items.reduce((s, i) => s + i.price * i.qty, 0);
}

export function applyDiscount(total, code) {
  if (code === "SAVE10") return total * 0.9;
  return total;
}

export function tax(total) {
  return total * 0.08;
}
`,
  "src/auth/session.js": `export function createSession(user) {
  return { user: user.id, expires: Date.now() + 3600_000 };
}
`,
  "src/slug.js": `export function slugify(s) {
  return s.toLowerCase().replace(/ /g, "-");
}
`,
  "test/cart.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { subtotal, applyDiscount } from "../src/cart.js";

test("subtotal", () => assert.equal(subtotal([{ price: 5, qty: 2 }]), 10));
test("discount", () => assert.equal(applyDiscount(100, "SAVE10"), 90));
`,
  "test/slug.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("basic", () => assert.equal(slugify("Hello World"), "hello-world"));
test("punctuation", () => assert.equal(slugify("Hello, World!"), "hello-world"));
test("trims dashes", () => assert.equal(slugify("  Hi  "), "hi"));
`,
};

async function call(p: string, body?: unknown, method = body ? "POST" : "GET") {
  const r = await fetch(BASE + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}

// Re-runnable: drop the previous demo project (and its worktrees) first.
const prev = await call("/api/state").catch(() => {
  console.error(`Octave isn't running at ${BASE}. Start it with "npm start" first.`);
  process.exit(1);
});
for (const p of prev.projects) if (p.name === path.basename(dir)) await call(`/api/projects/${p.id}`, undefined, "DELETE");

const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const [f, c] of Object.entries(files)) {
  mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  writeFileSync(path.join(dir, f), c);
}
writeFileSync(path.join(dir, ".env"), "STRIPE_KEY=sk_test_demo\n");
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.email=demo@octave.dev", "-c", "user.name=demo", "commit", "-qm", "Initial commit");
// The naive slugify fails the 'punctuation' and 'trims dashes' tests on main,
// which gives the tournament something real to fix.

// A scripted agent: prints like an agent, makes edits with a delay, then waits.
const agent = (lines: string[], edit: string) =>
  `custom:printf '\\033[36m●\\033[0m Reading the codebase…\\n'; sleep 1; ${lines.map((l) => `printf '\\033[2m  ${l}\\033[0m\\n'; sleep 0.6`).join("; ")}; ${edit}; printf '\\n\\033[32m✓\\033[0m Done. Waiting for your review.\\n'; exec $SHELL -l`;

const sed = (file: string, from: string, to: string) => `perl -0pi -e 's/${from}/${to}/' ${file}`;

const project = await call("/api/projects", { path: dir });
const mk = (name: string, prompt: string, cmd: string) =>
  call("/api/workspaces", { projectId: project.id, name, prompt, agent: cmd, bootstrap: false });

await mk(
  "bulk-discounts",
  "Add a BULK20 discount code for orders over $200",
  agent(["Editing src/cart.js"], sed("src/cart.js", 'if \\(code === "SAVE10"\\) return total \\* 0.9;', 'if (code === "SAVE10") return total * 0.9;\\n  if (code === "BULK20" \\&\\& total > 200) return total * 0.8;')),
);
await mk(
  "discount-refactor",
  "Refactor discounts into a lookup table",
  agent(["Editing src/cart.js", "Updating tests"], sed("src/cart.js", 'if \\(code === "SAVE10"\\) return total \\* 0.9;\\n  return total;', "const RATES = { SAVE10: 0.9 };\\n  return total * (RATES[code] ?? 1);")),
);
await mk(
  "tax-by-region",
  "Make tax depend on the shipping region",
  agent(["Editing src/cart.js"], sed("src/cart.js", "export function tax\\(total\\) \\{\\n  return total \\* 0.08;", "export function tax(total, region = \"US\") {\\n  return total * (region === \"EU\" ? 0.2 : 0.08);")),
);
await mk(
  "session-hardening",
  "Shorten session lifetime and add a migration for the sessions table",
  agent(["Editing src/auth/session.js", "Writing db/migrations/002_sessions.sql"],
    `${sed("src/auth/session.js", "3600_000", "900_000")}; mkdir -p db/migrations; printf 'ALTER TABLE sessions DROP COLUMN legacy_token;\\nALTER TABLE sessions ADD COLUMN rotated_at timestamptz;\\n' > db/migrations/002_sessions.sql`),
);
await mk("readme-polish", "Document the discount codes in the README", agent(["Editing README.md"], `printf '\\n## Discount codes\\n\\n- SAVE10: 10%% off\\n' >> README.md`));

await call("/api/tournaments", {
  projectId: project.id,
  prompt: "Fix slugify so punctuation is stripped and leading/trailing dashes are trimmed",
  verify: "npm test --silent",
  agents: [
    // careful: correct fix
    `custom:sleep 2; cat > src/slug.js <<'JS'\nexport function slugify(s) {\n  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\nJS`,
    // fast but incomplete: forgets trimming
    `custom:sleep 1; cat > src/slug.js <<'JS'\nexport function slugify(s) {\n  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/ +/g, "-");\n}\nJS`,
    // correct but sprawling: rewrites tests and adds a dependency manifest edit
    `custom:sleep 3; cat > src/slug.js <<'JS'\nconst DASH = "-";\n\nfunction normalize(s) {\n  return s.normalize("NFKD").toLowerCase();\n}\n\nfunction collapse(s) {\n  return s.replace(/[^a-z0-9]+/g, DASH);\n}\n\nfunction trim(s) {\n  return s.replace(/^-+/, "").replace(/-+$/, "");\n}\n\nexport function slugify(s) {\n  return trim(collapse(normalize(s)));\n}\nJS\nprintf '{\\n  "name": "demo-shop",\\n  "type": "module",\\n  "version": "0.0.2",\\n  "scripts": { "test": "node --test" }\\n}\\n' > package.json`,
  ],
});

// Meanwhile a teammate lands a change on main that touches the same line as
// session-hardening, so the radar can show "main moved underneath you".
await new Promise((r) => setTimeout(r, 6000));
writeFileSync(path.join(dir, "src/auth/session.js"), files["src/auth/session.js"].replace("3600_000", "7_200_000"));
git("-c", "user.email=teammate@octave.dev", "-c", "user.name=teammate", "commit", "-qam", "Extend sessions to 2h");

console.log(`\nDemo ready: ${dir}\nOpen ${BASE} and pick "octave-demo-shop".\n`);
