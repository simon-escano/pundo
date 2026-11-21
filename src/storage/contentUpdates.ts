import type { Storage } from "./index";
import { CONTENT_ID, FILIPINO_IDS, INGREDIENTS, PLAN, RECIPES } from "./content/2026-11-22";

/**
 * One-time content updates: data the app itself writes as ordinary synced mutations (outbox → server → other devices),
 * because seed fixtures never reach devices or the server once they are bootstrapped.
 *
 * Runs at most once per device (syncMeta flag), and only right after a successful sync, so a second device first sees what
 * the first one already wrote. Every step is idempotent and skips what is already there, so a crash halfway is resumed on
 * the next boot. Returns true when the update was applied (or had been already).
 */
export async function applyContentUpdate(s: Storage, sync: { syncOnce: () => Promise<{ ok: boolean }> } | null): Promise<boolean> {
  const key = `content:${CONTENT_ID}` as const;
  if (await s.db.syncMeta.get(key)) return true;
  if (!sync || !(await sync.syncOnce()).ok) return false; // retry on a later boot rather than write blind

  // 1. Ingredients (registry identity + seed price, then aisle/storage meta).
  for (const { aisle, storage_class, surface_prep, avg_unit_mass_g, ...ing } of INGREDIENTS) {
    if (await s.db.priceRegistry.get(ing.ingredient_id)) continue;
    await s.registry.ensure(ing);
    await s.meta.put({ ingredient_id: ing.ingredient_id, aisle, storage_class, surface_prep, avg_unit_mass_g });
  }

  // 2. New recipes. An id that exists (even soft-deleted) is left alone: the user's choice wins.
  for (const r of RECIPES) if (!(await s.db.recipes.get(r.id))) await s.recipes.put(r);

  // 3. Tag the Filipino library, but never overwrite tags someone already set.
  for (const id of FILIPINO_IDS) {
    const r = await s.recipes.get(id);
    if (r && r.tags.length === 0) await s.recipes.put({ ...r, tags: ["Filipino"] });
  }

  // 4. This week's plan, locked. Skipped if a newer plan already exists (the user has moved on).
  const newer = (await s.cycles.latest())?.start_date ?? "";
  if (newer <= PLAN.start_date) {
    const existing = await s.cycles.get(PLAN.id);
    const cycle = existing ?? (await s.cycles.create({ id: PLAN.id, start_date: PLAN.start_date, seed: PLAN.seed, shape: PLAN.shape }));
    if (cycle.status === "draft") {
      const have = (await s.cycles.getPlan(cycle.id)).dishes;
      const missing = PLAN.dishes.filter((d) => !have.some((h) => h.week === d.week && h.slot === d.slot));
      if (missing.length > 0) await s.cycles.setDishes(cycle.id, missing);
      await s.cycles.transition(cycle.id, "locked");
    }
  }

  await s.db.syncMeta.put({ key, value: 1 });
  return true;
}
