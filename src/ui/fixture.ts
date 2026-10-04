import Dexie from "dexie";
import { createStorage, type Storage } from "../storage";
import { rollPlan } from "./lib/actions";

// Dev-only deterministic demo (?fixture=demo[&state=locked]): fresh database, fixed clock, fixed ids,
// fixed cycle seed, so Playwright captures and flow tests are exactly reproducible.
export const FIXTURE_NOW = Date.UTC(2026, 9, 4, 8, 0, 0);
export const FIXTURE_SEED = 20261004;
export const FIXTURE_DB = "meal-prep-fixture";
export type FixtureState = "draft" | "locked";

export function fixtureFromLocation(loc: Pick<Location, "search">): FixtureState | null {
  if (!import.meta.env.DEV) return null;
  const p = new URLSearchParams(loc.search);
  if (p.get("fixture") !== "demo") return null;
  return p.get("state") === "locked" ? "locked" : "draft";
}

export async function createFixtureStorage(state: FixtureState): Promise<Storage> {
  await Dexie.delete(FIXTURE_DB);
  let n = 0;
  const s = await createStorage({ name: FIXTURE_DB, now: () => FIXTURE_NOW, newId: () => `fx-${String(++n).padStart(4, "0")}` });

  // Every recipe gets a demo reel so the video drawer is exercised.
  for (const r of await s.recipes.list()) {
    await s.recipes.put({ ...r, videos: [{ title: "Demo reel", platform: "youtube_shorts", url: "https://www.youtube.com/shorts/aqz-KE-bpKQ" }] });
  }
  const cycle = await s.cycles.create({ start_date: "2026-10-04", seed: FIXTURE_SEED });
  if (state === "locked") {
    const res = await rollPlan(s, cycle, false);
    if (!res.ok) throw new Error(`Fixture roll failed: ${res.error.detail}`);
    await s.cycles.transition(cycle.id, "locked");
    await s.pantry.add({ ingredient_id: "potato", state: "loose", quantity: 300, unit: "g" });
    await s.pantry.add({ ingredient_id: "red_onion", state: "loose", quantity: 200, unit: "g" });
    await s.pantry.add({ ingredient_id: "garlic", state: "loose", quantity: 50, unit: "g" });
  }
  return s;
}
