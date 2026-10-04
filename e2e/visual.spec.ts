import { test, expect } from "@playwright/test";
import { goto, openFixture, ROUTES, type Route } from "./helpers";

// Deterministic baselines: fixed clock, ids and cycle seed (?fixture=demo&state=locked), animations off.
const READY: Record<Route, string> = {
  plan: '[data-testid="dish-card"]',
  grocery: '[data-testid="grocery-line"]',
  "prep/day-1": '[data-testid="day1-task"]',
  prep: '[data-testid="prep-group"]',
  cook: '[data-testid="cook-card"]',
  recipes: '[data-testid="recipe-row"]',
};

test.describe("visual baselines (6 core views)", () => {
  for (const route of ROUTES) {
    test(route, async ({ page }) => {
      await openFixture(page, "plan", "locked");
      await goto(page, route);
      await expect(page.locator(READY[route]).first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page).toHaveScreenshot(`${route.replace("/", "-")}.png`, { fullPage: true });
    });
  }
});

test.describe("visual baselines (dark mode, signed-out screen)", () => {
  test.describe("dark", () => {
    test.use({ colorScheme: "dark" });
    for (const route of ["plan", "grocery"] as const) {
      test(`${route} (dark)`, async ({ page }) => {
        await openFixture(page, "plan", "locked");
        await goto(page, route);
        await expect(page.locator(READY[route]).first()).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(page).toHaveScreenshot(`${route}-dark.png`, { fullPage: true });
      });
    }
  });

  test("signed-out screen", async ({ page }) => {
    await page.goto("/?fixture=demo&state=locked&signin=1#/plan");
    await expect(page.getByTestId("signin-screen")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot("signin.png");
  });
});
