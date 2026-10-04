import { test, expect } from "@playwright/test";
import { closeDish, goto, money, openDish, openFixture } from "./helpers";

test("end to end: roll → lock → grocery → toss/stock → mark bought + calibrate → prep → cook", async ({ page }) => {
  await openFixture(page, "plan", "draft");

  // ── Roll ──
  await expect(page.getByTestId("cycle-dates")).toHaveText("Oct 4 – Oct 17");
  await expect(page.getByTestId("dish-empty")).toHaveCount(6);
  await page.getByRole("button", { name: "Roll dishes", exact: true }).click();
  await expect(page.getByTestId("dish-card")).toHaveCount(6);

  const w1 = page.getByTestId("week-1").getByTestId("dish-card");
  const w2 = page.getByTestId("week-2").getByTestId("dish-card");
  await expect(w1).toHaveCount(3);
  await expect(w2).toHaveCount(3);
  await expect(page.getByTestId("week-2")).toContainText("Only dishes that keep 2 weeks");
  for (const week of [w1, w2]) {
    const proteins = await week.getByTestId("protein-tag").allTextContents();
    for (const p of new Set(proteins)) expect(proteins.filter((x) => x === p).length).toBeLessThanOrEqual(2);
  }
  const names = await page.getByTestId("dish-card").locator("h3").allTextContents();
  expect(new Set(names).size).toBe(6); // no repeats in the cycle

  // ── Lock weeks, then the plan ──
  await page.getByRole("button", { name: "Lock week 1", exact: true }).click();
  await page.getByRole("button", { name: "Lock week 2", exact: true }).click();
  await expect(page.getByRole("button", { name: "Lock week 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Lock week 2", exact: true })).toHaveAttribute("aria-pressed", "true");
  const dish = await openDish(page);
  await expect(dish.getByRole("button", { name: /^Re-roll / })).toBeDisabled(); // locked dishes can't be re-rolled
  await closeDish(page);
  await page.getByRole("button", { name: "Lock plan" }).click();
  await expect(page.getByTestId("cycle-status")).toHaveText("Locked");
  await expect(page.getByRole("button", { name: "Roll again" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Go to grocery" })).toBeVisible(); // the next step is always offered

  // ── Grocery list ──
  await goto(page, "grocery");
  const aisles = await page.getByTestId("aisle").evaluateAll((els) => els.map((e) => e.getAttribute("data-aisle")));
  expect(aisles).toEqual(["produce", "fresh_meat", "canned_dry", "disposable"]);
  await expect(page.getByTestId("grocery-line").filter({ hasText: "RE-250" })).toContainText("12 pc"); // 6 dishes × 2 send-outs
  await expect(page.getByTestId("grocery-line").filter({ hasText: "Ask for" }).first()).toBeVisible(); // butcher notes

  // pantry stock + [Deduct Stock] vs [Tossed / Buy Full]
  const target = page.locator('[data-testid="grocery-line"][data-aisle="produce"][data-unit="g"]').first();
  const ingredient = (await target.getAttribute("data-ingredient"))!;
  await page.getByRole("button", { name: /Pantry stock/ }).click();
  await page.getByLabel("Ingredient", { exact: true }).selectOption(ingredient);
  await page.getByLabel("Quantity").fill("50");
  await page.getByLabel("Unit", { exact: true }).selectOption("g");
  await page.getByRole("button", { name: "Add stock" }).click();
  const line = page.locator(`[data-testid="grocery-line"][data-ingredient="${ingredient}"][data-unit="g"]`).first();
  await expect(line.getByTestId("need-qty")).toContainText("stock");
  const deducted = await line.getByTestId("buy-qty").textContent();
  await line.getByRole("button", { name: "Buy full" }).click();
  await expect(line.getByTestId("need-qty")).not.toContainText("stock");
  await expect(line.getByRole("button", { name: "Buy full" })).toHaveAttribute("aria-pressed", "true");
  await expect(line.getByTestId("buy-qty")).not.toHaveText(deducted!); // gross quantity restored
  await line.getByRole("button", { name: "Use my stock" }).click();
  await expect(line.getByTestId("buy-qty")).toHaveText(deducted!);

  // single bought checkbox
  const total = await page.getByTestId("grocery-line").count();
  await line.getByLabel(/^Bought:/).click(); // controlled input: state lands after the DB write round-trips
  await expect(line.getByLabel(/^Bought:/)).toBeChecked();
  await expect(page.getByTestId("bought-progress")).toHaveText(`1 of ${total} bought`);

  // ── Mark bought + calibrate from a receipt total ──
  const before = money(await page.getByTestId("estimate-total").textContent());
  await page.getByRole("button", { name: "Done shopping" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Receipt total (₱)").fill(String(before * 3));
  await dialog.getByRole("button", { name: "Save receipt" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("bought-progress")).toHaveText(`${total} of ${total} bought`);
  const after = money(await page.getByTestId("estimate-total").textContent());
  expect(after).toBeGreaterThan(before); // EMA moved prices toward the receipt…
  expect(after).toBeLessThan(before * 3); // …but smoothed rather than jumped

  // ── Prep board ──
  await goto(page, "prep");
  await expect(page.getByTestId("prep-group").first()).toBeVisible();
  const groups = page.getByTestId("prep-group");
  expect(await groups.count()).toBeGreaterThan(3);
  const cutsPerGroup = await groups.evaluateAll((gs) => gs.map((g) => new Set([...g.querySelectorAll('[data-testid="cut-row"]')].map((r) => r.getAttribute("data-cut"))).size));
  expect(Math.max(...cutsPerGroup)).toBeGreaterThanOrEqual(2); // one commodity branched into several cuts
  await expect(page.getByTestId("surface-prep").first()).toContainText(/Wash|Peel/);
  await expect(page.getByTestId("cut-row").first()).toContainText("bowl");
  await expect(page.getByTestId("staging")).toBeVisible();
  await page.getByRole("group", { name: "Prep section" }).getByRole("link", { name: "Week 2" }).click();
  await expect(page.getByTestId("prep-group").first()).toBeVisible();

  // ── Cook cards ──
  await goto(page, "cook");
  const cards = page.getByTestId("cook-card");
  await expect(cards).toHaveCount(3);
  const prio = await cards.evaluateAll((c) => c.map((e) => Number(e.getAttribute("data-priority"))));
  expect(prio).toEqual([...prio].sort((a, b) => a - b)); // burner order
  for (let i = 0; i < 3; i++) await expect(cards.nth(i).getByTestId("pack-step")).toHaveText("Fill solids first, sauce after.");
  await expect(cards.first().getByTestId("cook-steps")).toBeVisible();
  await cards.first().getByRole("button", { name: "Ingredients" }).click();
  await expect(cards.first().getByTestId("prep-items")).toBeVisible();
  await expect(cards.first().getByTestId("cook-steps")).toHaveCount(0);
  await cards.first().getByRole("button", { name: "Steps" }).click();
  await expect(cards.first().getByTestId("cook-steps")).toBeVisible();

  // ── Day 1 ──
  await goto(page, "prep/day-1");
  await expect(page.getByTestId("day1-task").first()).toBeVisible();
  await page.getByTestId("day1-task").first().getByRole("checkbox").check();
  await expect(page.getByTestId("day1-progress")).toContainText("1 of");
});

test("the fixture is deterministic: two fresh loads roll the identical plan", async ({ browser }) => {
  const read = async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await openFixture(page, "plan", "draft");
    await page.getByRole("button", { name: "Roll dishes", exact: true }).click();
    await expect(page.getByTestId("dish-card")).toHaveCount(6);
    const out = await page.getByTestId("dish-card").evaluateAll((c) => c.map((e) => e.getAttribute("data-recipe")));
    await ctx.close();
    return out;
  };
  expect(await read()).toEqual(await read());
});
