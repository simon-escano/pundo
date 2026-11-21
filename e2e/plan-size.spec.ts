import { expect, test, type Page } from "@playwright/test";
import { assertLayout } from "./helpers";

/** The demo fixture plus the shipped content update: the locked 1-week, 2-dish plan for Nov 22. */
async function openWeekPlan(page: Page, route = "plan") {
  await page.goto(`/?fixture=demo&content=1#/${route}`);
  await expect(page.locator("main[data-route]")).toBeVisible();
  await expect(page.getByTestId("view-loading")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

test("the 1-week plan shows one week of two locked dishes", async ({ page }) => {
  await openWeekPlan(page);
  await expect(page.getByTestId("cycle-dates")).toHaveText("Nov 22 – Nov 28");
  await expect(page.getByTestId("cycle-status")).toHaveText("Locked");
  await expect(page.getByTestId("week-2")).toHaveCount(0);
  const cards = page.getByTestId("week-1").getByTestId("dish-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute("data-recipe", "pork-pata-tokwa-braise");
  await expect(cards.nth(1)).toHaveAttribute("data-recipe", "beef-oyster-pepper-glaze");
  await assertLayout(page);
});

test("grocery needs four RE-250 containers and no week notes", async ({ page }) => {
  await openWeekPlan(page, "grocery");
  const containers = page.locator('[data-testid="grocery-line"][data-ingredient="re250_container"]');
  await expect(containers.getByTestId("buy-qty")).toContainText("4");
  await expect(page.getByText(/\(Week \d\)|^Week \d$/)).toHaveCount(0);
  await expect(page.locator('[data-ingredient="pork_pata"]')).toHaveCount(1);
  await assertLayout(page);
});

test("prep and cook have a single cook day (no Day 1 or Week 2 tabs)", async ({ page }) => {
  await openWeekPlan(page, "prep");
  await expect(page.getByRole("group", { name: "Prep section" })).toHaveCount(0);
  await page.goto("/?fixture=demo&content=1#/cook/week-2");
  await expect(page.getByRole("group", { name: "Cook day" })).toHaveCount(0);
  await expect(page.getByTestId("cook-card")).toHaveCount(2);
  await expect(page.getByTestId("cook-card").first()).toHaveAttribute("data-recipe", "pork-pata-tokwa-braise"); // slow braise first
});

test("recipes show tags and search matches them", async ({ page }) => {
  await openWeekPlan(page, "recipes");
  await page.getByRole("searchbox", { name: "Search recipes" }).fill("high-protein");
  await expect(page.getByTestId("recipe-row")).toHaveCount(2);
  await expect(page.getByTestId("recipe-row").first().getByTestId("recipe-tags")).toHaveText("Filipino · High-Protein");
  await page.getByRole("searchbox", { name: "Search recipes" }).fill("filipino");
  await expect(page.getByTestId("recipe-row")).toHaveCount(17);
});

test("New plan creates a 1-week, 2-dish draft that rolls two dishes", async ({ page }) => {
  await openWeekPlan(page);
  await page.getByRole("button", { name: "New plan" }).click();
  const dialog = page.getByRole("dialog", { name: "New plan" });
  await expect(dialog.getByRole("button", { name: "1 week · 2 dishes" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByLabel("Starts").fill("2026-11-22");
  await expect(dialog.getByRole("button", { name: "Create plan" })).toBeDisabled(); // not after the current plan
  await dialog.getByLabel("Starts").fill("2026-11-29");
  await expect(dialog.getByTestId("new-plan-range")).toHaveText("Nov 29 – Dec 5");
  await assertLayout(page);
  await dialog.getByRole("button", { name: "Create plan" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("cycle-dates")).toHaveText("Nov 29 – Dec 5");
  await expect(page.getByTestId("cycle-status")).toHaveText("Planning");
  await expect(page.getByTestId("dish-empty")).toHaveCount(2);
  await page.getByRole("button", { name: "Roll dishes" }).click();
  await expect(page.getByTestId("dish-card")).toHaveCount(2);
});
