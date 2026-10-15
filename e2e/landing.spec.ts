import { test, expect } from "@playwright/test";

test("landing page renders the pitch, live radar and about section", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("See which ones will collide");
  await expect(page.getByLabel("Animated example of Octave's conflict radar")).toBeVisible();
  for (const id of ["features", "how", "about", "install"]) await expect(page.locator(`#${id}`)).toBeAttached();
  await expect(page.locator("#about")).toContainText("Supratim Sarkar");
});

test("landing ships without the app's heavy dependencies (route code splitting)", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", (r) => r.resourceType() === "script" && scripts.push(new URL(r.url()).pathname));
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  expect(scripts.some((s) => /\/assets\/index-.*\.js$/.test(s))).toBe(true);
  // Clerk lives in the server chunk, xterm.js in the App chunk; neither should load here.
  expect(scripts.filter((s) => /\/assets\/(server|App|demo)-/.test(s))).toEqual([]);
  expect(scripts.some((s) => s.includes("clerk"))).toBe(false);
});

test("primary call to action opens the live demo", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try the live demo" }).first().click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole("note")).toContainText("Live demo");
});

test("/app on a static host explains how to install instead of hanging", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Octave runs on your machine" })).toBeVisible();
  await expect(page.locator("pre.install")).toContainText("npm install && npm start");
});
