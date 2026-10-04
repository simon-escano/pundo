import type { Recipe } from "../schemas/blueprint";
import { normalizeUnit } from "../units/units";

export type IngestIssue = { path: string; message: string; severity: "error" | "warning" };

const SNAKE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const RECIPE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const PRICE_KEYS = ["price", "price_php", "cost", "cost_php", "unit_price", "price_per_unit", "estimated_cost"];

/** Raw-JSON check: Zod strips unknown keys silently, so detect pricing fields before parsing. */
export function findPriceFields(raw: unknown): IngestIssue[] {
  const out: IngestIssue[] = [];
  const items = (raw as { prep_items?: unknown })?.prep_items;
  if (!Array.isArray(items)) return out;
  items.forEach((it, i) => {
    if (it && typeof it === "object") {
      for (const k of Object.keys(it)) {
        if (PRICE_KEYS.includes(k.toLowerCase())) {
          out.push({
            path: `prep_items[${i}].${k}`,
            message: "Pricing data is forbidden on prep items; prices live in the Global Price Registry.",
            severity: "error",
          });
        }
      }
    }
  });
  return out;
}

/** Domain rules beyond the Zod schema. Pure and deterministic. */
export function checkInvariants(r: Recipe): IngestIssue[] {
  const out: IngestIssue[] = [];
  const err = (path: string, message: string) => out.push({ path, message, severity: "error" });
  const warn = (path: string, message: string) => out.push({ path, message, severity: "warning" });

  if (!RECIPE_ID.test(r.id)) err("id", "Recipe id must be lowercase letters, digits, '-' or '_'.");
  if (!Number.isFinite(r.estimated_base_cost_php) || r.estimated_base_cost_php < 0) {
    err("estimated_base_cost_php", "Must be a non-negative number.");
  }
  if (r.prep_items.length === 0) err("prep_items", "At least one prep item is required.");
  if (r.cook_steps.length === 0) err("cook_steps", "At least one cook step is required.");

  r.cook_steps.forEach((s, i) => {
    if (s.trim() === "") err(`cook_steps[${i}]`, "Step must not be empty.");
    else if (/\d/.test(s)) err(`cook_steps[${i}]`, "Cook steps are action verbs and sensory cues only: no numbers.");
  });

  r.prep_items.forEach((p, i) => {
    const at = (f: string) => `prep_items[${i}].${f}`;
    if (!SNAKE.test(p.ingredient_id)) err(at("ingredient_id"), "Must be snake_case (e.g. red_onion).");
    if (!Number.isFinite(p.quantity_per_portion) || p.quantity_per_portion <= 0) {
      err(at("quantity_per_portion"), "Must be greater than zero.");
    }
    if (p.granularity === "discrete") {
      const n = p.pieces_per_portion;
      if (n === null || !Number.isInteger(n) || n < 1 || n > 6) {
        err(at("pieces_per_portion"), "Discrete items need an integer piece count from 1 to 6 per portion.");
      }
    } else if (p.granularity === "continuous") {
      if (p.pieces_per_portion !== null) err(at("pieces_per_portion"), "Continuous items have no piece count (use null).");
    } else if (p.pieces_per_portion !== null && !(p.pieces_per_portion > 0)) {
      err(at("pieces_per_portion"), "Must be null or greater than zero.");
    }
    if (p.cut_technique === "CUSTOM" && !(p.cut_note && p.cut_note.trim())) {
      err(at("cut_note"), "CUSTOM cuts require a cut_note describing the cut.");
    }
    if (p.packaging && !(p.packaging.pack_size > 0)) err(at("packaging.pack_size"), "Must be greater than zero.");
    if (!normalizeUnit(p.unit)) warn(at("unit"), `Unrecognised unit "${p.unit}": it will be kept separate and left unpriced.`);
  });

  return out;
}
