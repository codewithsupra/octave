import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      // Logic that runs in Node. React views are covered by the Playwright suite (e2e/).
      include: ["server/**/*.ts", "web/src/demo/**/*.ts"],
      exclude: ["server/index.ts"], // process entry point: env loading + listen()
      reporter: ["text-summary", "text", "json-summary"],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
