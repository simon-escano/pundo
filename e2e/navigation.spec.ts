import { test, expect } from "@playwright/test";
import { assertLayout, isNarrow, openFixture } from "./helpers";

test.describe("navigation and overlays", () => {
  test("the stage bar floats at the bottom centre, offset from the edge, and every stage is a direct link", async ({ page }) => {
    await openFixture(page, "plan", "locked");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link")).toHaveCount(4);
    for (const name of ["Plan", "Grocery", "Prep", "Cook"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Plan" })).toHaveAttribute("aria-current", "page");
    const vp = page.viewportSize()!;
    const box = (await nav.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(2); // centred
    expect(vp.height - (box.y + box.height)).toBeGreaterThan(8); // floating, not docked
    // jump straight to the last stage, then straight back to the first: no next/next needed
    await nav.getByRole("link", { name: "Cook", exact: true }).click();
    await expect(page.locator("main")).toHaveAttribute("data-route", "cook");
    await nav.getByRole("link", { name: "Plan", exact: true }).click();
    await expect(page.locator("main")).toHaveAttribute("data-route", "plan");
  });

  test("Recipes is a labelled header button, not an icon alone", async ({ page }) => {
    await openFixture(page, "plan", "locked");
    const link = page.getByRole("banner").getByRole("link", { name: "Recipes", exact: true });
    await expect(link).toBeVisible();
    await expect(link).toContainText("Recipes");
    await link.click();
    await expect(page.locator("main")).toHaveAttribute("data-route", "recipes");
    await expect(link).toHaveAttribute("aria-current", "page");
  });

  test("the old #/day-1 route redirects to Prep › Day 1", async ({ page }) => {
    await page.goto("/?fixture=demo&state=locked#/day-1");
    await expect(page.locator("main")).toHaveAttribute("data-route", "prep");
    await expect(page).toHaveURL(/#\/prep\/day-1$/);
    await expect(page.getByTestId("day1-task").first()).toBeVisible();
    await expect(page.getByRole("group", { name: "Prep section" }).getByRole("link", { name: "Day 1" })).toHaveAttribute("aria-current", "page");
  });

  test("weeks stack vertically and each week's dishes sit side by side", async ({ page }) => {
    await openFixture(page, "plan", "locked");
    const box = async (id: string) => (await page.getByTestId(id).boundingBox())!;
    const w1 = await box("week-1");
    const w2 = await box("week-2");
    expect(w2.y).toBeGreaterThan(w1.y + w1.height - 1);
    const cards = await page.getByTestId("week-1").getByTestId("dish-card").evaluateAll((c) => c.map((e) => e.getBoundingClientRect().top));
    expect(cards).toHaveLength(3);
    expect(Math.max(...cards) - Math.min(...cards)).toBeLessThan(2); // one row
  });

  test("on phones a dish tile opens a sheet", async ({ page }) => {
    test.skip(!isNarrow(page), "tiles are phone-only");
    await openFixture(page, "plan", "locked");
    await page.getByTestId("dish-card").first().getByRole("button", { name: /^Open / }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText("per portion");
    await assertLayout(page);
  });

  test("add-recipe modal: Esc closes it and focus returns to the plus button", async ({ page }) => {
    await openFixture(page, "recipes");
    const add = page.getByRole("button", { name: "Add recipe" });
    await add.click();
    const dialog = page.getByRole("dialog", { name: "Add recipe" });
    await expect(dialog.getByRole("button", { name: "Copy prompt" })).toBeVisible();
    await expect(dialog.getByLabel("Recipe JSON from Gemini")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Check", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save recipe" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(add).toBeFocused();
  });

  test("the signed-out screen explains what happened and offers a way back", async ({ page }) => {
    await page.goto("/?fixture=demo&state=locked&signin=1#/plan");
    const screen = page.getByTestId("signin-screen");
    await expect(screen.getByRole("heading", { name: "You’re signed out" })).toBeVisible();
    await expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
    await assertLayout(page);
    await screen.getByRole("button", { name: "Keep working offline" }).click();
    await expect(screen).toBeHidden();
  });

  test("dark mode renders with readable surfaces", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await openFixture(page, "plan", "locked");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe("rgb(246, 247, 248)");
    await assertLayout(page);
    await ctx.close();
  });
});
