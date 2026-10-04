import { test, expect } from "@playwright/test";
import { assertLayout, closeDish, goto, openDish, openFixture, ROUTES } from "./helpers";

test.describe("layout contract: no overflow, no snap/carousel, 44px targets", () => {
  for (const state of ["draft", "locked"] as const) {
    for (const route of ROUTES) {
      test(`${route} (${state} plan)`, async ({ page }) => {
        await openFixture(page, route, state);
        await assertLayout(page);
      });
    }
  }

  test("interactive sub-states: portion editor, pantry form, calibration modal, JSON editor, video drawer", async ({ page }) => {
    await openFixture(page, "plan", "draft");
    await page.getByRole("button", { name: "Roll dishes", exact: true }).click();
    await expect(page.getByTestId("dish-card")).toHaveCount(6);
    const dish = await openDish(page);
    if (!(await page.getByRole("dialog").count())) await dish.getByRole("button", { name: /Edit portions for/ }).click();
    await assertLayout(page);
    await closeDish(page);

    await openFixture(page, "grocery", "locked");
    await page.getByRole("button", { name: /Pantry stock/ }).click();
    await assertLayout(page);
    await page.getByRole("button", { name: "Done shopping" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertLayout(page);

    await openFixture(page, "recipes", "locked");
    await page.getByRole("button", { name: /Edit JSON for/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertLayout(page);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Add recipe" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertLayout(page);

    await openFixture(page, "cook", "locked");
    await page.getByRole("button", { name: /reel/i }).first().click();
    await assertLayout(page);
    await page.getByRole("button", { name: "Ingredients" }).first().click();
    await assertLayout(page);
    await goto(page, "prep");
    await assertLayout(page);
  });

  test("the page never captures horizontal scroll: a sideways scroll leaves scrollX at 0", async ({ page }) => {
    await openFixture(page, "grocery", "locked");
    await page.evaluate(() => window.scrollTo(200, 0));
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
  });
});
