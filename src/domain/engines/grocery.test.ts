import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Recipe } from "../schemas/blueprint";
import type { GroceryLineState } from "../schemas/app";
import seed from "../../../fixtures/ingredients.json";
import { makeItem, makeMeta, makePantry, makeRecipe, makeRegistry, pkg } from "../testing/factories";
import { buildGroceryList, RE250_ID, type GroceryInput } from "./grocery";
import { buildMiseEnPlace } from "./miseEnPlace";
import { buildDay1Protocol } from "./freezerProtocol";
import { recipeCost } from "./pricing";
import { rollCycle } from "./roller";
import { scaleRecipe } from "./scaling";

const meta = {
  potato: makeMeta("potato"),
  tomato_sauce: makeMeta("tomato_sauce", { aisle: "canned_dry", storage_class: "perishable_once_opened" }),
  liver_spread: makeMeta("liver_spread", { aisle: "canned_dry", storage_class: "shelf_stable_sealed" }),
  pork: makeMeta("pork", { aisle: "fresh_meat", storage_class: "fresh_meat" }),
  [RE250_ID]: makeMeta(RE250_ID, { aisle: "disposable", storage_class: "disposable" }),
};
const registry = makeRegistry([["potato", "piece", 10], ["tomato_sauce", "pouch", 22], ["liver_spread", "can", 18], ["pork", "kg", 300], [RE250_ID, "piece", 4]]);
const input = (recipes: [Recipe, 1 | 2][], over: Partial<GroceryInput> = {}): GroceryInput => ({
  cycleId: "c1", dishes: recipes.map(([r, w]) => scaleRecipe(r, 10, w)), pantry: [], meta, registry, lineState: [], ...over,
});
const find = (l: ReturnType<typeof buildGroceryList>, id: string, bucket?: string) => l.lines.filter((x) => x.ingredient_id === id && (!bucket || x.bucket === bucket));

const potatoes = makeRecipe({ id: "p", prep_items: [makeItem({ ingredient_id: "potato", unit: "pc", quantity_per_portion: 0.6 })] });
const sauce = (id: string, q = 18) => makeRecipe({ id, name: id, prep_items: [makeItem({ ingredient_id: "tomato_sauce", granularity: "continuous", quantity_per_portion: q, packaging: pkg("250 g pouch", 250) })] });
const liver = (id: string) => makeRecipe({ id, name: id, prep_items: [makeItem({ ingredient_id: "liver_spread", granularity: "continuous", quantity_per_portion: 12, packaging: pkg("85 g can", 85) })] });

describe("buildGroceryList golden cases", () => {
  it("need 6 potatoes − 2 in stock = buy 4", () => {
    const l = buildGroceryList(input([[potatoes, 1]], { pantry: [makePantry({ ingredient_id: "potato", quantity: 2, unit: "pc" })] }));
    expect(find(l, "potato")[0]).toMatchObject({ grossQuantity: 6, deductedQuantity: 2, netQuantity: 4, purchaseQuantity: 4, packs: null, estimatedCost: 40 });
  });
  it("[Spoiled / Tossed] (deduct_stock = 0) restores the gross buy quantity", () => {
    const state: GroceryLineState = { cycle_id: "c1", line_key: "potato|pc|cycle", deduct_stock: false, bought: false, paid_php: null, updated_at: "t" };
    const l = buildGroceryList(input([[potatoes, 1]], { pantry: [makePantry({ ingredient_id: "potato", quantity: 2, unit: "pc" })], lineState: [state] }));
    expect(find(l, "potato")[0]).toMatchObject({ netQuantity: 6, purchaseQuantity: 6, deductStock: false, reason: "TOSSED" });
  });
  it("180 g tomato sauce → 1 × 250 g pouch", () => {
    const l = buildGroceryList(input([[sauce("k"), 1]]));
    expect(find(l, "tomato_sauce")[0]).toMatchObject({ grossQuantity: 180, packs: 1, purchaseQuantity: 250, surplus: 70, estimatedCost: 22, highSurplus: false });
  });
  it("opened perishables snap per week; shelf-stable cans snap once per cycle", () => {
    const l = buildGroceryList(input([[sauce("a", 18), 1], [sauce("b", 18), 2], [liver("c"), 1], [liver("d"), 2]]));
    const s = find(l, "tomato_sauce");
    expect(s.map((x) => [x.bucket, x.packs])).toEqual([["w1", 1], ["w2", 1]]); // 2 pouches, one per week
    const c = find(l, "liver_spread");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ bucket: "cycle", grossQuantity: 240, packs: 3, purchaseQuantity: 255 }); // not 2 + 2 = 4
  });
  it("shared pantry stock is claimed once across week buckets", () => {
    const stock = makePantry({ ingredient_id: "tomato_sauce", state: "opened", quantity: 100, unit: "g", opened_cycle_id: "c1" });
    const l = buildGroceryList(input([[sauce("a"), 1], [sauce("b"), 2]], { pantry: [stock] }));
    expect(find(l, "tomato_sauce").map((x) => [x.bucket, x.deductedQuantity, x.netQuantity])).toEqual([["w1", 100, 80], ["w2", 0, 180]]);
  });
  it("a fully covered line stays visible with nothing to buy", () => {
    const l = buildGroceryList(input([[potatoes, 1]], { pantry: [makePantry({ ingredient_id: "potato", quantity: 9, unit: "pc" })] }));
    expect(find(l, "potato")[0]).toMatchObject({ netQuantity: 0, purchaseQuantity: 0, estimatedCost: 0 });
    expect(l.estimate.total).toBe(8); // only the 2 RE-250 containers (PHP 4 each) remain
  });
  it("RE-250 disposables = one per dispatched portion, priced from the registry", () => {
    const l = buildGroceryList(input([[potatoes, 1], [sauce("a"), 1], [liver("b"), 2]]));
    expect(l.containers).toBe(6);
    expect(find(l, RE250_ID)[0]).toMatchObject({ aisle: "disposable", purchaseQuantity: 6, estimatedCost: 24, unitLabel: "pc" });
    expect(l.lines.at(-1)!.ingredient_id).toBe(RE250_ID); // disposables sort last
  });
  it("no dispatch portions → no disposable line; line state attaches to the disposable line", () => {
    const small = [scaleRecipe(potatoes, 8, 1)];
    expect(find(buildGroceryList({ ...input([]), dishes: small }), RE250_ID)).toHaveLength(0);
    const state: GroceryLineState = { cycle_id: "c1", line_key: `${RE250_ID}|pc|cycle`, deduct_stock: true, bought: true, paid_php: 40, updated_at: "t" };
    expect(find(buildGroceryList(input([[potatoes, 1]], { lineState: [state, { ...state, cycle_id: "other", line_key: "potato|pc|cycle" }] })), RE250_ID)[0]).toMatchObject({ bought: true, paidPhp: 40 });
  });
  it("sorts Produce → Fresh Meat → Canned/Dry → Disposable and groups by aisle", () => {
    const meat = makeRecipe({ id: "m", name: "Adobo", prep_items: [makeItem({ ingredient_id: "pork", display_name: "Pork belly", cut_technique: "LARGE_DICE", cut_note: "Ask for 1-inch adobo cuts", granularity: "discrete", pieces_per_portion: 3, quantity_per_portion: 100 })] });
    const l = buildGroceryList(input([[liver("c"), 1], [meat, 1], [potatoes, 1]]));
    expect(l.aisles.map((a) => a.aisle)).toEqual(["produce", "fresh_meat", "canned_dry", "disposable"]);
    expect(l.lines.map((x) => x.ingredient_id)).toEqual(["potato", "pork", "liver_spread", RE250_ID]);
  });
  it("butcher notes carry cut notes and exact piece counts for fresh meat only", () => {
    const meat = makeRecipe({ id: "m", name: "Kaldereta", prep_items: [
      makeItem({ ingredient_id: "pork", display_name: "Pork shoulder", cut_technique: "LARGE_DICE", cut_note: "Ask for 1-inch adobo cuts", granularity: "discrete", pieces_per_portion: 3, quantity_per_portion: 90 }),
      makeItem({ ingredient_id: "pork", display_name: "Pork shoulder", cut_technique: "SLICED_THIN", granularity: "granular", quantity_per_portion: 10 }),
      makeItem({ ingredient_id: "pork", display_name: "Pork shoulder", cut_technique: "NONE", granularity: "continuous", quantity_per_portion: 10 }),
    ] });
    const l = buildGroceryList(input([[meat, 1], [potatoes, 1]]));
    expect(find(l, "pork")[0]!.butcherNotes).toEqual(["Pork shoulder for Kaldereta: Ask for 1-inch adobo cuts (30 pieces)", "Pork shoulder for Kaldereta: Slice thin slices"]);
    expect(find(l, "potato")[0]!.butcherNotes).toEqual([]);
  });
  it("conflicting packaging across recipes resolves to the smallest surplus", () => {
    const a = makeRecipe({ id: "a", prep_items: [makeItem({ ingredient_id: "tomato_sauce", granularity: "continuous", quantity_per_portion: 18, packaging: pkg("1 kg", 1000) })] });
    const b = sauce("b", 0.1);
    const l = buildGroceryList(input([[a, 1], [b, 1]]));
    expect(find(l, "tomato_sauce")[0]!.packaging?.retail_unit).toBe("250 g pouch");
  });
  it("flags high surplus lines", () => {
    const l = buildGroceryList(input([[sauce("a", 26), 1]]));
    expect(find(l, "tomato_sauce")[0]).toMatchObject({ packs: 2, highSurplus: true });
  });
  it("warns on missing meta and unknown units instead of guessing", () => {
    const odd = makeRecipe({ id: "o", prep_items: [makeItem({ ingredient_id: "mystery", unit: "handful", quantity_per_portion: 1 }), makeItem({ ingredient_id: "mystery", unit: "handful", quantity_per_portion: 1 })] });
    const l = buildGroceryList(input([[odd, 1]]));
    const line = find(l, "mystery")[0]!;
    expect(line.warnings.map((w) => w.code).sort()).toEqual(["MISSING_META", "UNKNOWN_UNIT"]);
    expect(line).toMatchObject({ unit: null, unitLabel: "handful", aisle: "canned_dry", grossQuantity: 20, estimatedCost: null });
    expect(l.estimate.unresolved).toContain("mystery");
  });
  it("same ingredient in different units stays on separate lines", () => {
    const r = makeRecipe({ id: "r", prep_items: [makeItem({ ingredient_id: "potato", unit: "pc", quantity_per_portion: 0.4 }), makeItem({ ingredient_id: "potato", unit: "g", quantity_per_portion: 30 })] });
    expect(find(buildGroceryList(input([[r, 1]])), "potato").map((x) => x.unitLabel)).toEqual(["g", "pc"]);
  });
  it("attaches bought/paid state by line key for this cycle only", () => {
    const state: GroceryLineState = { cycle_id: "c1", line_key: "potato|pc|cycle", deduct_stock: true, bought: true, paid_php: 55, updated_at: "t" };
    expect(find(buildGroceryList(input([[potatoes, 1]], { lineState: [state] })), "potato")[0]).toMatchObject({ bought: true, paidPhp: 55 });
  });
  it("is deterministic: same input twice, and dish order does not matter", () => {
    const rs: [Recipe, 1 | 2][] = [[sauce("a"), 1], [potatoes, 1], [liver("c"), 2]];
    expect(buildGroceryList(input(rs))).toEqual(buildGroceryList(input(rs)));
    expect(buildGroceryList(input([...rs].reverse()))).toEqual(buildGroceryList(input(rs)));
  });
});

describe("end to end on the seed fixtures: roll → scale → grocery → prep → day 1", () => {
  const recipes: Recipe[] = readdirSync("fixtures/recipes").map((f) => JSON.parse(readFileSync(`fixtures/recipes/${f}`, "utf8")));
  const reg = seed.registry as never;
  const m = seed.meta as never;

  for (const s of [1, 2, 3, 99, 2026]) {
    it(`seed ${s}: fully priced list, 12 RE-250s, aisle-ordered, deterministic`, () => {
      const roll = rollCycle({ pool: recipes, seed: s, locks: {}, previousCycleRecipeIds: new Set() });
      if (!roll.ok) throw new Error(roll.error.detail);
      const dishes = [...roll.week1.map((r) => scaleRecipe(r, 10, 1)), ...roll.week2.map((r) => scaleRecipe(r, 10, 2))];
      const gi = { cycleId: "c", dishes, pantry: [], meta: m, registry: reg, lineState: [] };
      const list = buildGroceryList(gi);
      expect(buildGroceryList(gi)).toEqual(list);
      expect(list.containers).toBe(12);
      expect(list.estimate.unresolved).toEqual([]);
      expect(list.estimate.total).toBeGreaterThan(500);
      expect(list.lines.flatMap((l) => l.warnings)).toEqual([]);
      const aisleIdx = list.lines.map((l) => ["produce", "fresh_meat", "canned_dry", "disposable"].indexOf(l.aisle));
      expect(aisleIdx).toEqual([...aisleIdx].sort((a, b) => a - b));
      for (const l of list.lines) expect(l.purchaseQuantity).toBeGreaterThanOrEqual(l.netQuantity - 1e-6);
      // Prep board and Day-1 build cleanly for both weeks
      for (const week of [1, 2] as const) {
        const board = buildMiseEnPlace(dishes.filter((d) => d.week === week), m);
        expect(board.groups.length + board.staging.length).toBeGreaterThan(0);
      }
      const day1 = buildDay1Protocol(dishes.filter((d) => d.week === 2), m);
      expect(day1.filter((t) => t.kind === "bag_label_meat").length).toBeGreaterThanOrEqual(0);
      expect(day1.some((t) => t.kind === "store_produce")).toBe(true);
    });
  }

  it("every fixture recipe is fully priceable from the seed registry (warm costing)", () => {
    for (const r of recipes) {
      const c = recipeCost(r, 10, reg);
      expect(c.unpriced, r.id).toEqual([]);
      expect(c.source).toBe("registry");
      expect(c.total).toBeGreaterThan(0);
    }
  });
});
