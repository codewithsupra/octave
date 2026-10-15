import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// WCAG 2.1 A/AA rules. xterm.js renders its own canvas/DOM, so it's excluded.
// The cast bridges @axe-core/playwright's bundled Page type and Playwright 1.63's.
const scan = (page: import("@playwright/test").Page) =>
  new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude(".term").analyze();

for (const [name, path, ready] of [
  ["landing", "/", "h1"],
  ["demo home", "/demo", ".board-cols"],
  ["demo radar", "/demo#/radar", ".matrix"],
  ["demo review", "/demo#/review", ".queue li"],
  ["demo tournament", "/demo#/tournament", "table.board"],
] as const) {
  test(`no WCAG A/AA violations: ${name}`, async ({ page }) => {
    await page.goto(path);
    await page.locator(ready).first().waitFor({ timeout: 20_000 });
    const { violations } = await scan(page);
    expect(violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) e.g. ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
  });
}
