import { hlcToIso, type Mutation, type MutationStatus, type Payload } from "../src/domain/sync/protocol";

// Every write is last-write-wins by HLC and expressed in SQL, so the guard is atomic inside D1
// even when two pushes interleave: `ON CONFLICT ... DO UPDATE ... WHERE excluded.hlc > stored.hlc`.

export type Plan = {
  stmts: D1PreparedStatement[];
  /** Did this mutation win (or was it already applied)? Read after the batch commits. */
  outcome: () => Promise<"applied" | "stale">;
  /** Ingredient whose registry price must be re-folded (observations only). */
  recompute?: string;
};

const json = (v: unknown) => (v === null ? null : JSON.stringify(v));

function log(db: D1Database, m: Mutation, payload: unknown, guard: string, ...guardParams: unknown[]) {
  // ?6.. are the guard's parameters. INSERT OR IGNORE + UNIQUE(entity, entity_key, hlc) makes replays harmless.
  return db
    .prepare(`INSERT OR IGNORE INTO change_log (entity, entity_key, hlc, device_id, payload) SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${guard}`)
    .bind(m.entity, m.entity_key, m.hlc, m.device_id, json(payload), ...guardParams);
}

const stampIs = (db: D1Database, sql: string, hlc: string, ...params: unknown[]) => async (): Promise<"applied" | "stale"> => {
  const r = await db.prepare(sql).bind(...params).first<{ h: string | null }>();
  return r?.h === hlc ? "applied" : "stale";
};

export function planFor(db: D1Database, m: Mutation, payload: unknown): Plan {
  const H = m.hlc;
  switch (m.entity) {
    case "recipe": {
      const { recipe: r, deleted } = payload as Payload["recipe"];
      const cur = "(SELECT updated_at FROM recipes WHERE id = ?1)";
      const stmts: D1PreparedStatement[] = [
        db
          .prepare(
            `INSERT INTO recipes (id, name, default_portions, protein_category, sauce_base, perishability_tier, stove_priority, estimated_base_cost_php, pack_step, updated_at, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, default_portions = excluded.default_portions, protein_category = excluded.protein_category,
               sauce_base = excluded.sauce_base, perishability_tier = excluded.perishability_tier, stove_priority = excluded.stove_priority,
               estimated_base_cost_php = excluded.estimated_base_cost_php, pack_step = excluded.pack_step, updated_at = excluded.updated_at, deleted = excluded.deleted
             WHERE excluded.updated_at > recipes.updated_at`,
          )
          .bind(r.id, r.name, r.default_portions, r.protein_category, r.sauce_base, r.perishability_tier, r.stove_priority, r.estimated_base_cost_php, r.pack_step, H, deleted ? 1 : 0),
      ];
      // Children are replaced only if this mutation is the current winner.
      for (const t of ["recipe_videos", "recipe_prep_items", "recipe_cook_steps"]) {
        stmts.push(db.prepare(`DELETE FROM ${t} WHERE recipe_id = ?1 AND ${cur} = ?2`).bind(r.id, H));
      }
      r.videos.forEach((v, i) =>
        stmts.push(db.prepare(`INSERT INTO recipe_videos (recipe_id, ord, title, platform, url) SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${cur} = ?6`).bind(r.id, i, v.title, v.platform, v.url, H)),
      );
      r.prep_items.forEach((p, i) =>
        stmts.push(
          db
            .prepare(
              `INSERT INTO recipe_prep_items (recipe_id, ord, ingredient_id, display_name, cut_technique, cut_note, granularity, pieces_per_portion, quantity_per_portion, unit, pkg_retail_unit, pkg_pack_size, pkg_snap_to_whole_pack)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13 WHERE ${cur} = ?14`,
            )
            .bind(r.id, i, p.ingredient_id, p.display_name, p.cut_technique, p.cut_note, p.granularity, p.pieces_per_portion, p.quantity_per_portion, p.unit,
              p.packaging?.retail_unit ?? null, p.packaging?.pack_size ?? null, p.packaging ? (p.packaging.snap_to_whole_pack ? 1 : 0) : null, H),
        ),
      );
      r.cook_steps.forEach((t, i) =>
        stmts.push(db.prepare(`INSERT INTO recipe_cook_steps (recipe_id, ord, text) SELECT ?1, ?2, ?3 WHERE ${cur} = ?4`).bind(r.id, i, t, H)),
      );
      stmts.push(log(db, m, payload, "(SELECT updated_at FROM recipes WHERE id = ?6) = ?3", r.id));
      return { stmts, outcome: stampIs(db, "SELECT updated_at AS h FROM recipes WHERE id = ?", H, r.id) };
    }

    case "priceRegistry": {
      const p = payload as Payload["priceRegistry"];
      return {
        stmts: [
          db
            .prepare(
              `INSERT INTO price_registry (ingredient_id, display_name, price_per_unit, pricing_unit, last_updated, hlc) VALUES (?1, ?2, 0, ?3, ?4, ?5)
               ON CONFLICT(ingredient_id) DO UPDATE SET display_name = excluded.display_name, pricing_unit = excluded.pricing_unit, hlc = excluded.hlc
               WHERE excluded.hlc > price_registry.hlc`,
            )
            .bind(p.ingredient_id, p.display_name, p.pricing_unit, hlcToIso(H), H),
          log(db, m, payload, "(SELECT hlc FROM price_registry WHERE ingredient_id = ?6) = ?3", p.ingredient_id),
        ],
        outcome: stampIs(db, "SELECT hlc AS h FROM price_registry WHERE ingredient_id = ?", H, p.ingredient_id),
      };
    }

    case "priceObservation": {
      const o = payload as Payload["priceObservation"];
      return {
        stmts: [
          db.prepare("INSERT OR IGNORE INTO price_observations (id, ingredient_id, kind, price, observed_at, cycle_id, device_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(o.id, o.ingredient_id, o.kind, o.price, o.observed_at, o.cycle_id, o.device_id),
          log(db, m, payload, "EXISTS (SELECT 1 FROM price_observations WHERE id = ?6)", o.id),
        ],
        outcome: async () => "applied", // append-only and idempotent: an existing id is the same fact
        recompute: o.ingredient_id,
      };
    }

    case "ingredientMeta": {
      const x = payload as Payload["ingredientMeta"];
      return {
        stmts: [
          db
            .prepare(
              `INSERT INTO ingredient_meta (ingredient_id, aisle, storage_class, surface_prep, avg_unit_mass_g, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT(ingredient_id) DO UPDATE SET aisle = excluded.aisle, storage_class = excluded.storage_class, surface_prep = excluded.surface_prep,
                 avg_unit_mass_g = excluded.avg_unit_mass_g, updated_at = excluded.updated_at WHERE excluded.updated_at > ingredient_meta.updated_at`,
            )
            .bind(x.ingredient_id, x.aisle, x.storage_class, x.surface_prep, x.avg_unit_mass_g, H),
          log(db, m, payload, "(SELECT updated_at FROM ingredient_meta WHERE ingredient_id = ?6) = ?3", x.ingredient_id),
        ],
        outcome: stampIs(db, "SELECT updated_at AS h FROM ingredient_meta WHERE ingredient_id = ?", H, x.ingredient_id),
      };
    }

    case "cycle": {
      const c = payload as Payload["cycle"];
      return {
        stmts: [
          db
            .prepare(
              `INSERT INTO cycles (id, start_date, seed, global_portions, status, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT(id) DO UPDATE SET start_date = excluded.start_date, seed = excluded.seed, global_portions = excluded.global_portions,
                 status = excluded.status, updated_at = excluded.updated_at WHERE excluded.updated_at > cycles.updated_at`,
            )
            .bind(c.id, c.start_date, c.seed, c.global_portions, c.status, H),
          log(db, m, payload, "(SELECT updated_at FROM cycles WHERE id = ?6) = ?3", c.id),
        ],
        outcome: stampIs(db, "SELECT updated_at AS h FROM cycles WHERE id = ?", H, c.id),
      };
    }

    case "cycleDish": {
      const d = payload as Payload["cycleDish"] | null;
      if (d === null) throw new Error("constraint: cycleDish deletes are server-originated only");
      // Intra-cycle exclusion under LWW: a newer placement of the same recipe evicts the older one
      // (and the eviction is logged so every device converges). A NEWER conflicting row makes the
      // UNIQUE(cycle_id, recipe_id) constraint fail, which rolls the whole batch back => stale.
      const conflict = "cycle_id = ?5 AND recipe_id = ?6 AND NOT (week = ?7 AND slot = ?8) AND hlc < ?3";
      return {
        stmts: [
          db
            .prepare(`INSERT OR IGNORE INTO change_log (entity, entity_key, hlc, device_id, payload) SELECT 'cycleDish', cycle_id || '|' || week || '|' || slot, ?3, ?4, NULL FROM cycle_dishes WHERE ${conflict}`)
            // Evictions are server-authored side effects: attribute them to "server" so the device that
            // triggered one never mistakes it for its own echo (it never had the evicted row applied).
            .bind(null, null, H, "server", d.cycle_id, d.recipe_id, d.week, d.slot),
          db.prepare(`DELETE FROM cycle_dishes WHERE cycle_id = ?1 AND recipe_id = ?2 AND NOT (week = ?3 AND slot = ?4) AND hlc < ?5`).bind(d.cycle_id, d.recipe_id, d.week, d.slot, H),
          db
            .prepare(
              `INSERT INTO cycle_dishes (cycle_id, week, slot, recipe_id, locked, portion_override, hlc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
               ON CONFLICT(cycle_id, week, slot) DO UPDATE SET recipe_id = excluded.recipe_id, locked = excluded.locked, portion_override = excluded.portion_override, hlc = excluded.hlc
               WHERE excluded.hlc > cycle_dishes.hlc`,
            )
            .bind(d.cycle_id, d.week, d.slot, d.recipe_id, d.locked ? 1 : 0, d.portion_override, H),
          log(db, m, { ...d, _hlc: H }, "(SELECT hlc FROM cycle_dishes WHERE cycle_id = ?6 AND week = ?7 AND slot = ?8) = ?3", d.cycle_id, d.week, d.slot),
        ],
        outcome: stampIs(db, "SELECT hlc AS h FROM cycle_dishes WHERE cycle_id = ?1 AND week = ?2 AND slot = ?3", H, d.cycle_id, d.week, d.slot),
      };
    }

    case "pantry": {
      const p = payload as Payload["pantry"] | null;
      const [ingredient, state] = m.entity_key.split("|") as [string, string];
      const alive = p !== null;
      return {
        stmts: [
          db
            .prepare(
              `INSERT INTO pantry_stock (ingredient_id, state, quantity, unit, opened_cycle_id, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
               ON CONFLICT(ingredient_id, state) DO UPDATE SET quantity = excluded.quantity, unit = excluded.unit, opened_cycle_id = excluded.opened_cycle_id,
                 updated_at = excluded.updated_at, deleted = excluded.deleted WHERE excluded.updated_at > pantry_stock.updated_at`,
            )
            .bind(ingredient, state, alive ? p.quantity : 0, alive ? p.unit : "g", alive ? p.opened_cycle_id : null, H, alive ? 0 : 1),
          log(db, m, payload, "(SELECT updated_at FROM pantry_stock WHERE ingredient_id = ?6 AND state = ?7) = ?3", ingredient, state),
        ],
        outcome: stampIs(db, "SELECT updated_at AS h FROM pantry_stock WHERE ingredient_id = ?1 AND state = ?2", H, ingredient, state),
      };
    }

    case "groceryLineState": {
      const g = payload as Payload["groceryLineState"];
      return {
        stmts: [
          db
            .prepare(
              `INSERT INTO grocery_line_state (cycle_id, line_key, deduct_stock, bought, paid_php, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT(cycle_id, line_key) DO UPDATE SET deduct_stock = excluded.deduct_stock, bought = excluded.bought, paid_php = excluded.paid_php,
                 updated_at = excluded.updated_at WHERE excluded.updated_at > grocery_line_state.updated_at`,
            )
            .bind(g.cycle_id, g.line_key, g.deduct_stock ? 1 : 0, g.bought ? 1 : 0, g.paid_php, H),
          log(db, m, payload, "(SELECT updated_at FROM grocery_line_state WHERE cycle_id = ?6 AND line_key = ?7) = ?3", g.cycle_id, g.line_key),
        ],
        outcome: stampIs(db, "SELECT updated_at AS h FROM grocery_line_state WHERE cycle_id = ?1 AND line_key = ?2", H, g.cycle_id, g.line_key),
      };
    }
  }
}

/** Map a D1/SQLite failure to a mutation status. Anything unrecognised is infrastructure: rethrow so the client retries. */
export function classifyError(e: unknown, entity: Mutation["entity"]): { status: MutationStatus; message: string } | null {
  const msg = e instanceof Error ? `${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ""}` : String(e);
  if (/FOREIGN KEY/i.test(msg)) return { status: "retry", message: "depends on data not yet on the server" };
  if (entity === "cycleDish" && /UNIQUE/i.test(msg)) return { status: "stale", message: "a newer placement of this recipe already exists" };
  if (/CHECK|NOT NULL|UNIQUE|constraint/i.test(msg)) return { status: "invalid", message: msg.replace(/^.*?(D1_ERROR:|Error:)\s*/, "").slice(0, 200) };
  return null;
}
