import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { goto, openFixture } from "./helpers";

const pinakbet = JSON.parse(readFileSync("fixtures/recipes/pinakbet.json", "utf8"));

test.describe("Screen Wake Lock: held only on /prep and /cook", () => {
  test("acquired on Prep and Cook, released everywhere else", async ({ page }) => {
    await page.addInitScript(() => {
      const w = { active: 0, requests: 0 };
      (window as unknown as { __wl: typeof w }).__wl = w;
      Object.defineProperty(navigator, "wakeLock", {
        value: {
          request: async () => {
            w.requests++;
            w.active++;
            let released = false;
            return { released: false, release: async () => { if (!released) { released = true; w.active--; } }, addEventListener() {} };
          },
        },
      });
    });
    const state = () => page.evaluate(() => (window as unknown as { __wl: { active: number; requests: number } }).__wl);
    await openFixture(page, "plan", "locked");
    expect((await state()).requests).toBe(0);
    for (const r of ["grocery", "day-1", "recipes"] as const) {
      await goto(page, r);
      expect((await state()).active).toBe(0);
    }
    await goto(page, "prep");
    await expect.poll(async () => (await state()).active).toBe(1);
    await goto(page, "cook");
    await expect.poll(async () => (await state()).requests).toBeGreaterThanOrEqual(2); // (dev StrictMode double-invokes effects)
    await expect.poll(async () => (await state()).active).toBe(1); // prep's lock released, cook's held
    await goto(page, "plan");
    await expect.poll(async () => (await state()).active).toBe(0);
  });
});

test.describe("video drawer", () => {
  test("embeds a 9:16 frame online and degrades cleanly offline", async ({ page, context }) => {
    await page.route(/youtube/, (r) => r.abort()); // never hit the network from tests
    await openFixture(page, "cook", "locked");
    const drawer = page.getByTestId("video-drawer").first();
    await expect(drawer.getByTestId("video-frame")).toHaveCount(0); // collapsed by default
    await drawer.getByRole("button", { name: /Reel/ }).click();
    const frame = drawer.getByTestId("video-frame");
    await expect(frame.locator("iframe")).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ");
    const box = (await frame.boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(9 / 16, 1);

    await context.setOffline(true);
    await expect(drawer.getByTestId("video-offline")).toContainText("Offline");
    await expect(frame.locator("iframe")).toHaveCount(0);
    await context.setOffline(false);
    await expect(frame.locator("iframe")).toHaveCount(1);
  });
});

test.describe("recipes: ingest pipeline and editor", () => {
  test("copies the schema & LLM prompt to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openFixture(page, "recipes");
    await page.getByRole("button", { name: "Copy Schema & LLM Prompt" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("JSON Schema");
    expect(clip).toContain("NEVER include price");
    expect(clip).toContain("CRUSHED_SMASHED");
    expect(clip).toContain("red_onion"); // known ingredient ids are offered for reuse
  });

  test("invalid JSON and invalid recipes show inline, located errors", async ({ page }) => {
    await openFixture(page, "recipes");
    await page.getByLabel("Recipe JSON from Gemini").fill('{\n "id": }');
    await page.getByRole("button", { name: "Check Recipe" }).click();
    await expect(page.getByTestId("ingest-errors")).toContainText("line 2");
    await expect(page.getByRole("button", { name: "Save Recipe" })).toBeDisabled();

    // schema + price-field errors
    const bad = structuredClone(pinakbet);
    bad.default_portions = 8;
    bad.prep_items[0].price_php = 12;
    await page.getByLabel("Recipe JSON from Gemini").fill(JSON.stringify(bad));
    await page.getByRole("button", { name: "Check Recipe" }).click();
    const errors = page.getByTestId("ingest-errors");
    await expect(errors).toContainText("default_portions");
    await expect(errors).toContainText("prep_items[0].price_php");

    // domain invariants (run once the schema passes): numbers in cook steps, bad discrete piece counts
    const rules = structuredClone(pinakbet);
    rules.cook_steps[0] = "Sear for 5 minutes.";
    await page.getByLabel("Recipe JSON from Gemini").fill(JSON.stringify(rules));
    await page.getByRole("button", { name: "Check Recipe" }).click();
    await expect(errors).toContainText("cook_steps[0]");
    await expect(errors).toContainText("no numbers");
  });

  test("new ingredient: inline row prefilled with a suggested unit, requires aisle + storage class, then saves into the roller pool", async ({ page }) => {
    await openFixture(page, "recipes");
    const r = structuredClone(pinakbet);
    r.id = "pinakbet-spicy";
    r.name = "Spicy Pinakbet";
    r.prep_items.push({ ...r.prep_items[0], ingredient_id: "labuyo", display_name: "Labuyo", unit: "g" });
    await page.getByLabel("Recipe JSON from Gemini").fill(JSON.stringify(r));
    await page.getByRole("button", { name: "Check Recipe" }).click();

    const row = page.getByTestId("new-ingredient");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("New Ingredient Detected");
    await expect(row.getByLabel(/Pricing unit/)).toHaveValue("kg"); // prefilled from the recipe's grams

    await page.getByRole("button", { name: "Save Recipe" }).click(); // aisle + storage class still missing
    await expect(page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: "highlighted" })).toBeVisible();
    await expect(row.getByLabel(/Aisle/)).toHaveAttribute("aria-invalid", "true");
    await expect(row.getByLabel(/Storage class/)).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("recipe-row").filter({ hasText: "Spicy Pinakbet" })).toHaveCount(0);

    await row.getByLabel(/Unit price/).fill("400");
    await row.getByLabel(/Aisle/).selectOption("produce");
    await row.getByLabel(/Storage class/).selectOption("loose_produce");
    await page.getByRole("button", { name: "Save Recipe" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved “Spicy Pinakbet”" })).toBeVisible();
    await expect(page.getByTestId("recipe-row").filter({ hasText: "Spicy Pinakbet" })).toHaveCount(1);
    await expect(page.getByLabel("Recipe JSON from Gemini")).toHaveValue("");
  });

  test("raw JSON editor: save an edit, and see field-path errors for a bad one", async ({ page }) => {
    await openFixture(page, "recipes");
    await page.getByRole("button", { name: "Edit JSON for Pinakbet" }).click();
    const dialog = page.getByRole("dialog");
    const editor = dialog.getByLabel("Recipe JSON");
    await expect(editor).toHaveValue(/"id": "pinakbet"/);
    const original = await editor.inputValue();

    await editor.fill(original.replace('"default_portions": 10', '"default_portions": 8'));
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByTestId("editor-errors")).toContainText("default_portions");

    await editor.fill(original.replace('"name": "Pinakbet"', '"name": "Pinakbet (edited)"'));
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("recipe-row").filter({ hasText: "Pinakbet (edited)" })).toHaveCount(1);
  });

  test("soft delete and restore", async ({ page }) => {
    await openFixture(page, "recipes");
    const row = page.getByTestId("recipe-row").filter({ hasText: "Pinakbet" }).first();
    await row.getByRole("button", { name: /^Delete/ }).click();
    await expect(row).toContainText("deleted");
    await expect(page.getByRole("heading", { name: "Library (14)" })).toBeVisible();
    await row.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("heading", { name: "Library (15)" })).toBeVisible();
  });
});

test.describe("plan view", () => {
  test("infeasible roll shows an actionable inline alert", async ({ page }) => {
    await openFixture(page, "recipes");
    await expect(page.getByRole("heading", { name: "Library (15)" })).toBeVisible(); // the Recipes view is lazy: wait for it
    const hardy = page.getByTestId("recipe-row").filter({ hasText: "Hardy" }).filter({ hasNotText: "deleted" });
    const n = await hardy.count();
    expect(n).toBe(10);
    for (let i = 1; i <= n; i++) {
      await hardy.first().getByRole("button", { name: /^Delete/ }).click();
      await expect(page.getByRole("heading", { name: `Library (${15 - i})` })).toBeVisible(); // wait for the live query
    }
    await goto(page, "plan");
    await page.getByRole("button", { name: "Roll Cycle", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: "more hardy dish" });
    await expect(alert).toContainText("Need 3 more hardy dishes");
    await expect(alert).toContainText("TIER_2_HARDY");
    await expect(page.getByTestId("dish-card")).toHaveCount(0);
  });

  test("portion stepper, per-dish override, single re-roll, and the 8 + N allocation", async ({ page }) => {
    await openFixture(page, "plan");
    await page.getByRole("button", { name: "Roll Cycle", exact: true }).click();
    const cards = page.getByTestId("dish-card");
    await expect(cards).toHaveCount(6);
    await expect(cards.first()).toContainText("10 portions · 8 freezer + 2 send-out");

    await page.getByRole("button", { name: "Increase portions", exact: true }).click();
    await expect(cards.first()).toContainText("11 portions · 8 freezer + 3 send-out");
    await expect(page.getByRole("group", { name: "portions", exact: true }).getByRole("status")).toHaveText("11");

    await cards.nth(1).getByRole("button", { name: /Edit portions/ }).click();
    await cards.nth(1).getByRole("button", { name: /^Decrease/ }).click();
    await expect(cards.nth(1)).toContainText("10 portions");
    await expect(cards.nth(1)).toContainText("override");
    await cards.nth(1).getByRole("button", { name: "Use global" }).click();
    await expect(cards.nth(1)).toContainText("11 portions");

    const before = await cards.evaluateAll((c) => c.map((e) => e.getAttribute("data-recipe")));
    await cards.nth(4).getByRole("button", { name: /^Re-roll/ }).click();
    await expect.poll(async () => (await cards.evaluateAll((c) => c.map((e) => e.getAttribute("data-recipe"))))[4]).not.toBe(before[4]);
    const after = await cards.evaluateAll((c) => c.map((e) => e.getAttribute("data-recipe")));
    expect(after.filter((x, i) => x !== before[i])).toHaveLength(1); // only the target changed
  });

  test("a re-roll of Week 1 respects the locked Week 2 and keeps the rules", async ({ page }) => {
    await openFixture(page, "plan");
    await page.getByRole("button", { name: "Roll Cycle", exact: true }).click();
    await page.getByRole("button", { name: "Lock Week 2", exact: true }).click();
    const w2 = () => page.getByTestId("week-2").getByTestId("dish-card").evaluateAll((c) => c.map((e) => e.getAttribute("data-recipe")));
    const locked = await w2();
    await page.getByRole("button", { name: "Roll Cycle", exact: true }).click();
    await expect.poll(w2).toEqual(locked);
  });
});

test("persistence in the real database: a reload restores the plan and its locks", async ({ page }) => {
  await page.goto("/#/plan"); // normal mode: real IndexedDB, real clock, random seed
  await page.getByRole("button", { name: "Roll Cycle", exact: true }).click();
  await expect(page.getByTestId("dish-card")).toHaveCount(6);
  await page.getByRole("button", { name: "Lock Week 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Lock Week 1", exact: true })).toHaveAttribute("aria-pressed", "true"); // written, then reload
  const ids = await page.getByTestId("dish-card").evaluateAll((c) => c.map((e) => e.getAttribute("data-recipe")));

  await page.reload();
  await expect(page.getByTestId("dish-card")).toHaveCount(6);
  expect(await page.getByTestId("dish-card").evaluateAll((c) => c.map((e) => e.getAttribute("data-recipe")))).toEqual(ids);
  await expect(page.getByRole("button", { name: "Lock Week 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Lock Week 2", exact: true })).toHaveAttribute("aria-pressed", "false");
});
