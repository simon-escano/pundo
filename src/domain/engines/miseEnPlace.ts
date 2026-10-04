import type { Aisle, IngredientMeta } from "../schemas/app";
import { CutTechniqueEnum } from "../schemas/blueprint";
import { compareBy, compareStrings } from "../math/compare";
import { roundDp, safeCeil } from "../math/precision";
import type { CanonicalUnit } from "../units/units";
import { CUT_LABELS, type CutTechnique } from "./cuts";
import { STOVE_RANK } from "./stove";
import type { Packaging, ScaledDish, ScaledPrepItem } from "./scaling";
import { joinQty, pluralize } from "./text";

export type IngredientMetaMap = Readonly<Record<string, IngredientMeta>>;

export type BowlRoute = {
  recipeId: string;
  recipeName: string;
  stovePriority: ScaledPrepItem["stovePriority"];
  quantity: number;
  unit: CanonicalUnit | null;
  unitLabel: string;
  pieces: number | null; // exact cut count (discrete)
  approxCount: number | null; // "medium" pieces, from the ingredient's avg_unit_mass_g
  cutNote: string | null;
};

export type CutBranch = {
  cut: CutTechnique;
  branchKey: string; // CUSTOM branches key on their note so unlike custom cuts never merge
  label: string;
  verb: string;
  noun: string;
  totalQuantity: number;
  totalPieces: number | null;
  unitLabel: string;
  routes: BowlRoute[];
};

export type PrepGroup = {
  ingredient_id: string;
  display_name: string;
  aisle: Aisle;
  totals: { unit: string; quantity: number }[]; // one entry per unit; units are never summed together
  approxCount: number | null;
  approxMassG: number | null;
  surfacePrep: string | null;
  branches: CutBranch[];
};

export type StagingLine = { ingredient_id: string; display_name: string; text: string; routes: BowlRoute[] };
export type PrepBoard = { groups: PrepGroup[]; staging: StagingLine[] };

const AISLE_ORDER: Record<Aisle, number> = { produce: 0, fresh_meat: 1, canned_dry: 2, disposable: 3 };
const CUT_ORDER = new Map<string, number>(CutTechniqueEnum.options.map((c, i) => [c, i]));

/** avg_unit_mass_g is the mass of one "medium" piece. */
function approxPieces(quantity: number, unit: CanonicalUnit | null, avg: number | null | undefined): number | null {
  if (!avg) return null;
  if (unit === "g") return safeCeil(quantity / avg);
  if (unit === "pc") return quantity;
  return null;
}
function approxMass(quantity: number, unit: CanonicalUnit | null, avg: number | null | undefined): number | null {
  if (unit === "g") return roundDp(quantity, 6);
  if (unit === "pc" && avg) return roundDp(quantity * avg, 6);
  return null;
}

const isStaging = (it: ScaledPrepItem, meta: IngredientMeta | undefined): boolean =>
  it.item.cut_technique === "NONE" &&
  (it.packaging !== undefined || meta?.storage_class === "shelf_stable_sealed" || meta?.storage_class === "perishable_once_opened");

function route(it: ScaledPrepItem, avg: number | null | undefined): BowlRoute {
  return {
    recipeId: it.recipeId,
    recipeName: it.recipeName,
    stovePriority: it.stovePriority,
    quantity: it.grossQuantity,
    unit: it.unit,
    unitLabel: it.unitLabel,
    pieces: it.totalPieces,
    approxCount: approxPieces(it.grossQuantity, it.unit, avg),
    cutNote: it.item.cut_note,
  };
}

const compareRoutes = compareBy<BowlRoute>(
  (a, b) => STOVE_RANK[a.stovePriority] - STOVE_RANK[b.stovePriority],
  (a, b) => compareStrings(a.recipeName, b.recipeName),
  (a, b) => compareStrings(a.recipeId, b.recipeId),
);

/** Merge routes of the same recipe (same ingredient + cut listed twice) by summing. */
function mergeRoutes(routes: BowlRoute[]): BowlRoute[] {
  const m = new Map<string, BowlRoute>();
  for (const r of routes) {
    const k = `${r.recipeId}|${r.unitLabel}`;
    const e = m.get(k);
    if (!e) m.set(k, { ...r });
    else {
      e.quantity = roundDp(e.quantity + r.quantity, 6);
      e.pieces = e.pieces === null && r.pieces === null ? null : (e.pieces ?? 0) + (r.pieces ?? 0);
      e.approxCount = e.approxCount === null || r.approxCount === null ? null : e.approxCount + r.approxCount;
    }
  }
  return [...m.values()].sort(compareRoutes);
}

const CONTAINER_WORDS = ["can", "pouch", "sachet", "pack", "bottle", "jar", "box", "bag", "tub", "carton"] as const;
const CONTAINER_VERB: Record<(typeof CONTAINER_WORDS)[number], string> = {
  can: "Open", jar: "Open", pouch: "Snip", sachet: "Snip", pack: "Snip", bag: "Snip", box: "Open", tub: "Open", carton: "Open", bottle: "Measure",
};

function containerWord(pkg: Packaging): (typeof CONTAINER_WORDS)[number] {
  const tokens = pkg.retail_unit.toLowerCase().split(/[^a-z]+/);
  return CONTAINER_WORDS.find((w) => tokens.includes(w)) ?? "pack";
}

function stagingText(name: string, items: ScaledPrepItem[]): string {
  const first = items[0]!;
  const total = roundDp(items.reduce((s, i) => s + i.grossQuantity, 0), 6);
  const lower = name.toLowerCase();
  const pkg = first.packaging;
  if (!pkg) return `Measure ${joinQty(total, first.unitLabel)} ${lower}`;
  const word = containerWord(pkg);
  const packs = Math.max(1, safeCeil(total / pkg.pack_size));
  return `${CONTAINER_VERB[word]} ${packs} ${pluralize(word, packs)} (${joinQty(pkg.pack_size, first.unitLabel)}) ${lower}`;
}

/**
 * Unified Mise en Place for one cook day. Level 1 groups by ingredient_id (wash/peel);
 * level 2 branches by cut technique (knife station); routes name the bowl for each cut,
 * braise bowls first. Sealed/canned NONE-cut items become staging lines instead.
 */
export function buildMiseEnPlace(dishes: readonly ScaledDish[], meta: IngredientMetaMap): PrepBoard {
  const all = dishes.flatMap((d) => d.items);
  const grouped = new Map<string, ScaledPrepItem[]>();
  const staged = new Map<string, ScaledPrepItem[]>();
  for (const it of all) {
    const target = isStaging(it, meta[it.item.ingredient_id]) ? staged : grouped;
    const list = target.get(it.item.ingredient_id) ?? [];
    list.push(it);
    target.set(it.item.ingredient_id, list);
  }

  const groups: PrepGroup[] = [];
  for (const [id, items] of grouped) {
    const m = meta[id];
    const avg = m?.avg_unit_mass_g ?? null;
    const name = items[0]!.item.display_name;

    const totalsMap = new Map<string, { unit: CanonicalUnit | null; quantity: number }>();
    for (const it of items) {
      const t = totalsMap.get(it.unitLabel) ?? { unit: it.unit, quantity: 0 };
      t.quantity = roundDp(t.quantity + it.grossQuantity, 6);
      totalsMap.set(it.unitLabel, t);
    }
    const totals = [...totalsMap].sort((a, b) => compareStrings(a[0], b[0])).map(([unit, t]) => ({ unit, quantity: t.quantity }));
    const single = totalsMap.size === 1 ? [...totalsMap.values()][0]! : null;

    const byBranch = new Map<string, { cut: CutTechnique; items: ScaledPrepItem[] }>();
    for (const it of items) {
      const cut = it.item.cut_technique;
      const key = cut === "CUSTOM" ? `CUSTOM:${it.item.cut_note ?? ""}` : cut;
      const e = byBranch.get(key) ?? { cut, items: [] };
      e.items.push(it);
      byBranch.set(key, e);
    }
    const branches: CutBranch[] = [...byBranch]
      .sort((a, b) => (CUT_ORDER.get(a[1].cut)! - CUT_ORDER.get(b[1].cut)!) || compareStrings(a[0], b[0]))
      .map(([branchKey, b]) => {
        const lbl = CUT_LABELS[b.cut];
        const pieces = b.items.every((i) => i.totalPieces !== null) ? b.items.reduce((s, i) => s + i.totalPieces!, 0) : null;
        return {
          cut: b.cut,
          branchKey,
          label: lbl.label,
          verb: lbl.verb,
          noun: lbl.noun,
          totalQuantity: roundDp(b.items.reduce((s, i) => s + i.grossQuantity, 0), 6),
          totalPieces: pieces,
          unitLabel: b.items[0]!.unitLabel,
          routes: mergeRoutes(b.items.map((i) => route(i, avg))),
        };
      });

    groups.push({
      ingredient_id: id,
      display_name: name,
      aisle: m?.aisle ?? "produce",
      totals,
      approxCount: single ? approxPieces(single.quantity, single.unit, avg) : null,
      approxMassG: single ? approxMass(single.quantity, single.unit, avg) : null,
      surfacePrep: m?.surface_prep ?? null,
      branches,
    });
  }
  groups.sort(
    compareBy<PrepGroup>(
      (a, b) => AISLE_ORDER[a.aisle] - AISLE_ORDER[b.aisle],
      (a, b) => compareStrings(a.display_name, b.display_name),
      (a, b) => compareStrings(a.ingredient_id, b.ingredient_id),
    ),
  );

  const staging: StagingLine[] = [...staged]
    .map(([id, items]) => ({
      ingredient_id: id,
      display_name: items[0]!.item.display_name,
      text: stagingText(items[0]!.item.display_name, items),
      routes: mergeRoutes(items.map((i) => route(i, null))),
    }))
    .sort((a, b) => compareStrings(a.display_name, b.display_name) || compareStrings(a.ingredient_id, b.ingredient_id));

  return { groups, staging };
}

function routeAmount(r: BowlRoute): string {
  if (r.approxCount !== null && r.unit === "g") return `${r.approxCount} medium`;
  return joinQty(r.quantity, r.unitLabel);
}

export type GroupRow = { cut: CutTechnique; tag: string; text: string; size: string | null; bowl: string; recipeId: string };
export type FormattedGroup = { id: string; heading: string; surface: string | null; rows: GroupRow[] };
export type FormattedStaging = { id: string; text: string; stations: string[] };

/** Presentation-ready lines for one ingredient group (shared by the text checklist and the UI). */
export function formatGroup(g: PrepGroup): FormattedGroup {
  const heading =
    g.approxCount !== null && g.approxMassG !== null
      ? `${g.display_name.toUpperCase()} (${g.approxCount} medium total / ~${g.approxMassG}g)`
      : g.totals.length > 0
        ? `${g.display_name.toUpperCase()} (${g.totals.map((t) => joinQty(t.quantity, t.unit)).join(" + ")} total)`
        : g.display_name.toUpperCase();
  let surface: string | null = null;
  if (g.surfacePrep) {
    const what = g.approxCount !== null ? `all ${g.approxCount} ${pluralize(g.display_name.toLowerCase(), g.approxCount)}` : `the ${g.display_name.toLowerCase()}`;
    surface = `${g.surfacePrep} ${what}`;
  }
  const rows: GroupRow[] = g.branches.flatMap((b) =>
    b.routes.map((r) => ({
      cut: b.cut,
      tag: b.cut,
      text: `${b.verb} ${routeAmount(r)}${r.pieces !== null ? ` into ${r.pieces} ${b.noun}` : ""}`,
      size: CUT_LABELS[b.cut].size,
      bowl: `${r.recipeName} Bowl`,
      recipeId: r.recipeId,
    })),
  );
  return { id: g.ingredient_id, heading, surface, rows };
}

export function formatStaging(board: PrepBoard): FormattedStaging[] {
  return board.staging.map((s) => ({ id: s.ingredient_id, text: s.text, stations: s.routes.map((r) => `${r.recipeName} Station`) }));
}

/** Plain-text Master Prep Checklist (blueprint §4B), one line per entry. */
export function formatChecklist(board: PrepBoard): string[] {
  const lines: string[] = [];
  for (const g of board.groups.map(formatGroup)) {
    lines.push(`[ ] ${g.heading}`);
    if (g.surface) lines.push(`    • Surface Prep: ${g.surface}`);
    for (const r of g.rows) lines.push(`    • [${r.tag}]: ${r.text} ──> [${r.bowl}]`);
  }
  const staging = formatStaging(board);
  if (staging.length > 0) {
    lines.push("[ ] CANNED & SAUCE STAGING");
    for (const s of staging) lines.push(`    • ${s.text} ──> [${s.stations.join(", ")}]`);
  }
  return lines;
}
