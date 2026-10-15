import { test, expect, type Page } from "@playwright/test";

const cell = (page: Page, a: string, b: string) => page.getByRole("button", { name: `${a} and ${b}: conflict` });

test.describe("live demo", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/demo");
    // Scripted agents finish their first edits within ~10s.
    await expect(page.locator(".ws-list")).toContainText("session-hardening");
  });

  test("conflict radar: detects a collision, a heads-up resolves it", async ({ page }) => {
    await page.goto("/demo#/radar");
    const conflict = cell(page, "bulk-discounts", "discount-refactor");
    await expect(conflict).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".radar-side")).toContainText("conflicts with main", { timeout: 15_000 });

    await conflict.click();
    await expect(page.locator(".callout.bad")).toContainText("src/cart.ts");
    await page.getByRole("button", { name: "Warn discount-refactor" }).click();
    await expect(page.locator(".toast")).toContainText("Heads-up sent to discount-refactor");
    await expect(page.locator("button.cell.conflict")).toHaveCount(0, { timeout: 12_000 });
  });

  test("review queue puts the destructive migration first, with reasons", async ({ page }) => {
    await page.goto("/demo#/review");
    const first = page.locator(".queue > li").first();
    await expect(first).toContainText("session-hardening", { timeout: 15_000 });
    await expect(first).toContainText("destructive SQL");
    await expect(first.locator(".risk")).toHaveClass(/risk-high/);
  });

  test("tournament ranks entrants by checks, then risk, then size", async ({ page }) => {
    await page.goto("/demo#/tournament");
    const rows = page.locator("table.board tbody tr");
    await expect(rows.first()).toContainText("winner", { timeout: 20_000 });
    await expect(rows.first()).toContainText("passed");
    await expect(rows.last()).toContainText("failed");
  });

  test("agent hooks surface a permission request as 'Needs your approval'", async ({ page }) => {
    await expect(page.locator(".ws-pills")).toContainText("1 to approve", { timeout: 15_000 });
    await page.locator(".ws-list").getByRole("button", { name: /session-hardening/ }).click();
    await expect(page.locator(".ws-detail.attention")).toContainText("permission to use Bash");
    await expect(page.locator(".src.hooks")).toHaveText("live from hooks");
    await expect(page.locator(".xterm-rows")).toContainText("Allow this command?");
  });

  test("a new workspace from the dialog starts an agent and shows its diff", async ({ page }) => {
    await page.getByRole("button", { name: "New workspace" }).first().click();
    await page.getByRole("dialog").locator("textarea").fill("Add a WELCOME10 coupon for first orders");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.locator(".ws-title h1")).toHaveText("add-a-welcome10-coupon-for");
    await expect(page.locator("button.file")).toContainText("src/cart.ts", { timeout: 10_000 });
  });
});
