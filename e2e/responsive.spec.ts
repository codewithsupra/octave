import { test, expect } from "@playwright/test";

for (const path of ["/", "/demo", "/demo#/review", "/demo#/tournament"]) {
  test(`no horizontal scroll at phone width: ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
    expect(scroll).toBeLessThanOrEqual(width);
  });
}
