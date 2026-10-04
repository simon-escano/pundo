import { describe, expect, it } from "vitest";
import { makeItem, makeMeta, makeRecipe, pkg } from "../testing/factories";
import { buildMiseEnPlace, formatChecklist } from "./miseEnPlace";
import { buildDay1Protocol } from "./freezerProtocol";
import { compareStovePriority, orderByStovePriority, STOVE_LABEL, STOVE_RANK } from "./stove";
import { addDays, cycleRanges, formatCycleRange, formatIsoDate, formatRange, parseIsoDate } from "./dates";
import { scaleRecipe } from "./scaling";
import { joinQty, pluralize } from "./text";
import { CUT_LABELS } from "./cuts";
import { CutTechniqueEnum } from "../schemas/blueprint";

const meta = {
  potato: makeMeta("potato", { surface_prep: "Wash and peel", avg_unit_mass_g: 150 }),
  red_onion: makeMeta("red_onion", { surface_prep: "Peel", avg_unit_mass_g: 110 }),
  liver_spread: makeMeta("liver_spread", { aisle: "canned_dry", storage_class: "shelf_stable_sealed" }),
  tomato_sauce: makeMeta("tomato_sauce", { aisle: "canned_dry", storage_class: "perishable_once_opened" }),
  pork: makeMeta("pork", { aisle: "fresh_meat", storage_class: "fresh_meat" }),
  tomato: makeMeta("tomato"),
};

const kaldereta = makeRecipe({
  id: "kaldereta", name: "Kaldereta", stove_priority: "PRIORITY_1_SLOW_BRAISE",
  prep_items: [
    makeItem({ ingredient_id: "potato", cut_technique: "LARGE_DICE", granularity: "discrete", pieces_per_portion: 2, quantity_per_portion: 30 }),
    makeItem({ ingredient_id: "red_onion", cut_technique: "MEDIUM_DICE", quantity_per_portion: 11 }),
    makeItem({ ingredient_id: "liver_spread", granularity: "continuous", quantity_per_portion: 8.5, packaging: pkg("85 g can", 85) }),
    makeItem({ ingredient_id: "tomato_sauce", granularity: "continuous", quantity_per_portion: 18, packaging: pkg("250 g pouch", 250) }),
  ],
});
const giniling = makeRecipe({
  id: "giniling", name: "Giniling", stove_priority: "PRIORITY_2_FAST_SAUTE",
  prep_items: [
    makeItem({ ingredient_id: "potato", cut_technique: "SMALL_DICE", quantity_per_portion: 30 }),
    makeItem({ ingredient_id: "red_onion", cut_technique: "SMALL_DICE", quantity_per_portion: 22 }),
  ],
});
const bistek = makeRecipe({
  id: "bistek", name: "Bistek", stove_priority: "PRIORITY_2_FAST_SAUTE",
  prep_items: [makeItem({ ingredient_id: "red_onion", cut_technique: "SLICED_RINGS", quantity_per_portion: 11 })],
});
const dishes = [bistek, giniling, kaldereta].map((r) => scaleRecipe(r, 10, 1));

describe("buildMiseEnPlace: blueprint Master Prep Checklist", () => {
  const board = buildMiseEnPlace(dishes, meta);

  it("reproduces the blueprint checklist (two-level aggregation, bowl routing, staging)", () => {
    expect(formatChecklist(board)).toEqual([
      "[ ] POTATO (4 medium total / ~600g)",
      "    • Surface Prep: Wash and peel all 4 potatoes",
      "    • [LARGE_DICE]: Cut 2 medium into 20 chunks ──> [Kaldereta Bowl]",
      "    • [SMALL_DICE]: Dice finely 2 medium ──> [Giniling Bowl]",
      "[ ] RED ONION (4 medium total / ~440g)",
      "    • Surface Prep: Peel all 4 red onions",
      "    • [MEDIUM_DICE]: Dice 1 medium ──> [Kaldereta Bowl]",
      "    • [SMALL_DICE]: Dice finely 2 medium ──> [Giniling Bowl]",
      "    • [SLICED_RINGS]: Slice 1 medium ──> [Bistek Bowl]",
      "[ ] CANNED & SAUCE STAGING",
      "    • Open 1 can (85g) liver spread ──> [Kaldereta Station]",
      "    • Snip 1 pouch (250g) tomato sauce ──> [Kaldereta Station]",
    ]);
  });

  it("level 1 groups by ingredient_id; level 2 branches by CutTechniqueEnum order", () => {
    expect(board.groups.map((g) => g.ingredient_id)).toEqual(["potato", "red_onion"]);
    const onion = board.groups[1]!;
    expect(onion.branches.map((b) => b.cut)).toEqual(["MEDIUM_DICE", "SMALL_DICE", "SLICED_RINGS"]);
    expect(onion.totals).toEqual([{ unit: "g", quantity: 440 }]);
    expect(board.groups[0]!.branches[0]).toMatchObject({ totalPieces: 20, totalQuantity: 300, label: "Large dice", noun: "chunks" });
  });

  it("sealed/canned NONE-cut items are staged, not grouped", () => {
    expect(board.staging.map((s) => s.ingredient_id)).toEqual(["liver_spread", "tomato_sauce"]);
    expect(board.groups.map((g) => g.ingredient_id)).not.toContain("liver_spread");
  });
});

describe("buildMiseEnPlace: edge cases", () => {
  it("bowl routes are sorted by stove priority (braise first), then name", () => {
    const a = makeRecipe({ id: "a", name: "Zeta", stove_priority: "PRIORITY_3_FINISH_LAST", prep_items: [makeItem({ ingredient_id: "tomato", cut_technique: "MEDIUM_DICE" })] });
    const b = makeRecipe({ id: "b", name: "Alpha", stove_priority: "PRIORITY_2_FAST_SAUTE", prep_items: [makeItem({ ingredient_id: "tomato", cut_technique: "MEDIUM_DICE" })] });
    const c = makeRecipe({ id: "c", name: "Mid", stove_priority: "PRIORITY_1_SLOW_BRAISE", prep_items: [makeItem({ ingredient_id: "tomato", cut_technique: "MEDIUM_DICE" })] });
    const board = buildMiseEnPlace([a, b, c].map((r) => scaleRecipe(r, 10, 1)), meta);
    expect(board.groups[0]!.branches[0]!.routes.map((r) => r.recipeName)).toEqual(["Mid", "Alpha", "Zeta"]);
  });

  it("CUSTOM cuts with different notes never merge; same recipe listed twice sums", () => {
    const r = makeRecipe({ id: "r", name: "R", prep_items: [
      makeItem({ ingredient_id: "tomato", cut_technique: "CUSTOM", cut_note: "thin crescents", quantity_per_portion: 10 }),
      makeItem({ ingredient_id: "tomato", cut_technique: "CUSTOM", cut_note: "thick slabs", quantity_per_portion: 10 }),
      makeItem({ ingredient_id: "tomato", cut_technique: "MEDIUM_DICE", quantity_per_portion: 5 }),
      makeItem({ ingredient_id: "tomato", cut_technique: "MEDIUM_DICE", quantity_per_portion: 5, granularity: "discrete", pieces_per_portion: 1 }),
    ] });
    const g = buildMiseEnPlace([scaleRecipe(r, 10, 1)], meta).groups[0]!;
    expect(g.branches.map((b) => b.branchKey)).toEqual(["MEDIUM_DICE", "CUSTOM:thick slabs", "CUSTOM:thin crescents"]);
    const dice = g.branches[0]!;
    expect(dice.routes).toHaveLength(1);
    expect(dice.routes[0]).toMatchObject({ quantity: 100, pieces: 10 });
    expect(dice.totalPieces).toBeNull(); // mixed discrete/non-discrete
  });

  it("units are never summed together; unknown units stay separate", () => {
    const r = makeRecipe({ id: "r", name: "R", prep_items: [
      makeItem({ ingredient_id: "tomato", unit: "g", quantity_per_portion: 10 }),
      makeItem({ ingredient_id: "tomato", unit: "pc", quantity_per_portion: 1 }),
      makeItem({ ingredient_id: "tomato", unit: "handful", quantity_per_portion: 1 }),
    ] });
    const g = buildMiseEnPlace([scaleRecipe(r, 10, 1)], meta).groups[0]!;
    expect(g.totals).toEqual([{ unit: "g", quantity: 100 }, { unit: "handful", quantity: 10 }, { unit: "pc", quantity: 10 }]);
    expect(g.approxCount).toBeNull();
    expect(formatChecklist({ groups: [g], staging: [] })[0]).toBe("[ ] TOMATO (100g + 10 handful + 10 pc total)");
  });

  it("piece-counted ingredients with avg mass report mass; groups sort by aisle then name", () => {
    const r = makeRecipe({ id: "r", name: "R", prep_items: [
      makeItem({ ingredient_id: "potato", unit: "pc", quantity_per_portion: 0.4, cut_technique: "WHOLE" }),
      makeItem({ ingredient_id: "pork", granularity: "continuous", quantity_per_portion: 100 }),
      makeItem({ ingredient_id: "unknown_thing" }),
    ] });
    const g = buildMiseEnPlace([scaleRecipe(r, 10, 1)], meta).groups;
    expect(g.map((x) => x.ingredient_id)).toEqual(["potato", "unknown_thing", "pork"]); // missing meta defaults to produce
    expect(g[0]).toMatchObject({ approxCount: 4, approxMassG: 600 });
  });

  it("staging without packaging, plural packs, bottle/jar wording", () => {
    const mk = (id: string, name: string, p: ReturnType<typeof pkg> | undefined, q: number, unit = "g") => makeItem({ ingredient_id: id, display_name: name, granularity: "continuous", quantity_per_portion: q, unit, ...(p ? { packaging: p } : {}) });
    const r1 = makeRecipe({ id: "r1", name: "One", prep_items: [mk("liver_spread", "Liver spread", pkg("85 g can", 85), 17), mk("soy", "Soy sauce", pkg("385 mL bottle", 385), 30, "ml"), mk("jam", "Jam", pkg("270 g jar", 270), 5), mk("odd", "Odd", pkg("ziplock of 5", 5), 0.5, "pc")] });
    const r2 = makeRecipe({ id: "r2", name: "Two", prep_items: [mk("tomato_sauce", "Tomato sauce", undefined, 20)] });
    const lines = buildMiseEnPlace([r1, r2].map((r) => scaleRecipe(r, 10, 1)), { ...meta, soy: makeMeta("soy", { storage_class: "shelf_stable_sealed" }), tomato_sauce: makeMeta("tomato_sauce", { storage_class: "shelf_stable_sealed" }) }).staging.map((s) => s.text);
    expect(lines).toEqual([
      "Open 1 jar (270g) jam",
      "Open 2 cans (85g) liver spread",
      "Snip 1 pack (5 pc) odd",
      "Measure 1 bottle (385ml) soy sauce",
      "Measure 200g tomato sauce",
    ]);
  });

  it("an ingredient listed with packaging in one dish and aggregated across two dishes stages once with both stations", () => {
    const mk = (id: string) => makeRecipe({ id, name: id, prep_items: [makeItem({ ingredient_id: "tomato_sauce", granularity: "continuous", quantity_per_portion: 18, packaging: pkg("250 g pouch", 250) })] });
    const s = buildMiseEnPlace([mk("a"), mk("b")].map((r) => scaleRecipe(r, 10, 1)), meta).staging;
    expect(s).toHaveLength(1);
    expect(s[0]!.text).toBe("Snip 2 pouches (250g) tomato sauce");
    expect(formatChecklist({ groups: [], staging: s })[1]).toBe("    • Snip 2 pouches (250g) tomato sauce ──> [a Station, b Station]");
  });

  it("surface prep without a known piece weight reads naturally", () => {
    const r = makeRecipe({ id: "r", name: "R", prep_items: [makeItem({ ingredient_id: "carrot" })] });
    const board = buildMiseEnPlace([scaleRecipe(r, 10, 1)], { carrot: makeMeta("carrot", { surface_prep: "Wash and peel" }) });
    expect(formatChecklist(board)[1]).toBe("    • Surface Prep: Wash and peel the carrot");
  });
});

describe("buildDay1Protocol", () => {
  const mk = (id: string, name: string, items: ReturnType<typeof makeItem>[]) => scaleRecipe(makeRecipe({ id, name, prep_items: items }), 10, 2);
  const w2 = [
    mk("adobo", "Pork Adobo", [
      makeItem({ ingredient_id: "pork", display_name: "Pork belly", cut_technique: "LARGE_DICE", cut_note: "1-inch adobo cuts", granularity: "discrete", pieces_per_portion: 3, quantity_per_portion: 100 }),
      makeItem({ ingredient_id: "potato" }),
    ]),
    mk("nilaga", "Pork Nilaga", [
      makeItem({ ingredient_id: "pork", display_name: "Pork belly", granularity: "continuous", quantity_per_portion: 80 }),
      makeItem({ ingredient_id: "potato" }),
      makeItem({ ingredient_id: "tomato" }),
      makeItem({ ingredient_id: "liver_spread" }),
    ]),
  ];
  const tasks = buildDay1Protocol(w2, meta);
  it("bags and labels W2 meats to piece specs, then stores hardy produce unwashed", () => {
    expect(tasks.map((t) => t.text)).toEqual([
      "Bag and label pork belly for Pork Adobo: cut 30 chunks (1-inch adobo cuts), freeze flat",
      "Bag and label pork belly for Pork Nilaga: portion 800g, freeze flat",
      "Store potato unwashed in paper towels",
      "Store tomato unwashed in paper towels",
    ]);
    expect(tasks.map((t) => t.kind)).toEqual(["bag_label_meat", "bag_label_meat", "store_produce", "store_produce"]);
  });
  it("de-duplicates produce across dishes and lists every dish", () => {
    expect(tasks.find((t) => t.ingredient_id === "potato")!.recipeIds).toEqual(["adobo", "nilaga"]);
  });
  it("is empty for empty input", () => expect(buildDay1Protocol([], meta)).toEqual([]));
});

describe("stove", () => {
  const r = (id: string, name: string, p: "PRIORITY_1_SLOW_BRAISE" | "PRIORITY_2_FAST_SAUTE" | "PRIORITY_3_FINISH_LAST") => makeRecipe({ id, name, stove_priority: p });
  it("orders Priority 1 → 3, then name, then id", () => {
    const out = orderByStovePriority([r("3", "A", "PRIORITY_3_FINISH_LAST"), r("2b", "B", "PRIORITY_2_FAST_SAUTE"), r("2a", "B", "PRIORITY_2_FAST_SAUTE"), r("1", "Z", "PRIORITY_1_SLOW_BRAISE")]);
    expect(out.map((x) => x.id)).toEqual(["1", "2a", "2b", "3"]);
  });
  it("exposes ranks and labels", () => {
    expect(STOVE_RANK.PRIORITY_1_SLOW_BRAISE).toBe(1);
    expect(STOVE_LABEL.PRIORITY_3_FINISH_LAST).toBe("Finish");
    expect(compareStovePriority("PRIORITY_1_SLOW_BRAISE", "PRIORITY_3_FINISH_LAST")).toBeLessThan(0);
  });
});

describe("dates", () => {
  it("parses and validates ISO dates", () => {
    expect(parseIsoDate("2026-10-04")).not.toBeNull();
    for (const bad of ["2026-02-30", "2026-13-01", "10/04/2026", "2026-1-4", ""]) expect(parseIsoDate(bad)).toBeNull();
  });
  it("addDays crosses month, year and leap boundaries in UTC", () => {
    expect(addDays("2026-10-04", 13)).toBe("2026-10-17");
    expect(addDays("2026-12-30", 5)).toBe("2027-01-04");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-10-04", -4)).toBe("2026-09-30");
    expect(() => addDays("nope", 1)).toThrow(RangeError);
    expect(formatIsoDate(Date.UTC(2026, 9, 4))).toBe("2026-10-04");
  });
  it("cycle ranges and labels match the blueprint (Oct 4–10 | Oct 11–17)", () => {
    const c = cycleRanges("2026-10-04");
    expect(c.week1).toEqual({ start: "2026-10-04", end: "2026-10-10" });
    expect(c.week2).toEqual({ start: "2026-10-11", end: "2026-10-17" });
    expect(formatRange(c.week1.start, c.week1.end)).toBe("Oct 4–10");
    expect(formatRange(c.week2.start, c.week2.end)).toBe("Oct 11–17");
    expect(formatCycleRange("2026-10-04")).toBe("Oct 4 – Oct 17");
    expect(formatRange("2026-09-28", "2026-10-04")).toBe("Sep 28–Oct 4");
    expect(formatCycleRange("2026-12-28")).toBe("Dec 28 – Jan 10");
    expect(() => formatRange("bad", "2026-10-04")).toThrow(RangeError);
  });
});

describe("text & cut vocabulary", () => {
  it("joinQty attaches metric units and spaces counted ones", () => {
    expect([joinQty(600, "g"), joinQty(250, "ml"), joinQty(1, "pack"), joinQty(10, "pc")]).toEqual(["600g", "250ml", "1 pack", "10 pc"]);
  });
  it("pluralize", () => {
    expect([pluralize("potato", 4), pluralize("red onion", 4), pluralize("radish", 2), pluralize("berry", 3), pluralize("can", 1), pluralize("taco", 2), pluralize("box", 2)]).toEqual(["potatoes", "red onions", "radishes", "berries", "can", "tacos", "boxes"]);
  });
  it("CUT_LABELS covers every CutTechniqueEnum value", () => {
    expect(Object.keys(CUT_LABELS).sort()).toEqual([...CutTechniqueEnum.options].sort());
  });
});
