import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOctaveServer } from "./app";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Clerk keys from `clerk env pull` (.env.local) or a hand-written .env.
for (const f of [".env.local", ".env"]) {
  const file = path.join(ROOT, f);
  if (existsSync(file)) process.loadEnvFile(file);
}

const env = process.env;
let app;
try {
  app = createOctaveServer({
    home: env.OCTAVE_HOME ?? path.join(os.homedir(), ".octave"),
    port: Number(env.OCTAVE_PORT ?? 7420),
    clerk: {
      secretKey: env.CLERK_SECRET_KEY,
      jwtKey: env.CLERK_JWT_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY ?? env.VITE_CLERK_PUBLISHABLE_KEY,
    },
    publicUrl: env.OCTAVE_PUBLIC_URL,
    allowedUsers: (env.OCTAVE_ALLOWED_USERS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
  });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const port = await app.listen();
const where = env.OCTAVE_PUBLIC_URL ? new URL(env.OCTAVE_PUBLIC_URL).origin : `http://localhost:${port}`;
console.log(`\n  ♪ Octave running at ${where}\n    state: ${app.store.home}\n    auth:  ${app.gate.enabled ? "Clerk (owner-locked)" : "off (local only)"}\n`);

const shutdown = () => app.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
