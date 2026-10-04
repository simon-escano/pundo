import { Droplets, FileJson, Snowflake } from "lucide-react";
import { CUT_LABELS } from "../../domain/engines/cuts";
import type { PrepItem, Recipe } from "../../domain/schemas/blueprint";
import type { IngredientMeta } from "../../domain/schemas/app";
import { toCanonical } from "../../domain/units/units";
import { formatMoney, formatQuantity, PROTEIN_LABEL, SAUCE_LABEL, TIER_LABEL } from "../lib/format";
import { VideoDrawer } from "./VideoDrawer";
import { Button, cx, Modal, PROTEIN_ICON, PROTEIN_TINT, StoveOrder } from "./ui";

const PORTIONS = 10; // every recipe is written for 10 portions (blueprint invariant)

/** "50 g x 10" -> "500 g". Units we don't recognise are shown as written, never guessed. */
function amount(q: number, unit: string): string {
  const c = toCanonical(q, unit);
  return c ? formatQuantity(c.quantity, c.unit) : `${Math.round(q * 100) / 100} ${unit}`;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-9" aria-label={title}>
      <h3 className="font-display text-2xl font-extrabold">{title}</h3>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Ingredient({ item }: { item: PrepItem }) {
  const cut = CUT_LABELS[item.cut_technique];
  const total = amount(item.quantity_per_portion * PORTIONS, item.unit);
  return (
    <li className="border-b border-line py-3.5 last:border-0" data-testid="recipe-ingredient">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[17px] font-semibold">{item.display_name}</span>
        <span className="font-display text-xl font-bold tabular-nums">{total}</span>
      </div>
      <p className="mt-0.5 text-sm text-muted">
        {amount(item.quantity_per_portion, item.unit)} per portion
        {item.cut_technique !== "NONE" && <> · {cut.label}{cut.size ? ` (${cut.size})` : ""}</>}
        {item.pieces_per_portion !== null && <> · {Math.round(item.pieces_per_portion * PORTIONS * 100) / 100} pieces in total</>}
      </p>
      {item.cut_note && <p className="mt-0.5 text-sm">{item.cut_note}</p>}
      {item.packaging && <p className="mt-0.5 text-sm text-muted">Sold as {item.packaging.retail_unit}{item.packaging.snap_to_whole_pack ? " (buy whole packs)" : ""}</p>}
    </li>
  );
}

/**
 * Everything the recipe JSON says, laid out to be read: what it is, what to buy, how to cut it, how to cook it,
 * how to pack it. Quantities are for the standard 10 portions; the plan scales them per cycle.
 */
export function RecipeDetailModal({ recipe: r, meta, deleted, onClose, onEdit }: { recipe: Recipe; meta: Record<string, IngredientMeta>; deleted: boolean; onClose: () => void; onEdit: () => void }) {
  const Icon = PROTEIN_ICON[r.protein_category];
  const cutting = r.prep_items.filter((p) => p.cut_technique !== "NONE" || meta[p.ingredient_id]?.surface_prep);
  return (
    <Modal title={r.name} onClose={onClose} wide>
      <div data-testid="recipe-detail">
        <div className={cx("-mx-5 -mt-1 px-5 pb-5 pt-4", PROTEIN_TINT[r.protein_category])}>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm font-medium text-ink/75">
            <span className="inline-flex items-center gap-1"><Icon aria-hidden className="size-4" strokeWidth={2.25} />{PROTEIN_LABEL[r.protein_category]}</span>
            <span>{TIER_LABEL[r.perishability_tier]}</span>
            <span>{SAUCE_LABEL[r.sauce_base]} sauce</span>
            {deleted && <span className="font-semibold text-danger">Deleted</span>}
          </p>
          <div className="mt-2"><StoveOrder priority={r.stove_priority} long /></div>
          <dl className="mt-4 grid grid-cols-3 gap-3">
            {[
              [`${PORTIONS}`, "portions"],
              [`${r.prep_items.length}`, "ingredients"],
              [`${r.cook_steps.length}`, "steps"],
            ].map(([n, l]) => (
              <div key={l}>
                <dt className="text-xs font-medium text-ink/70">{l}</dt>
                <dd className="font-display text-3xl font-extrabold leading-none tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-ink/75">
            About <strong className="font-semibold text-ink tabular-nums">{formatMoney(r.estimated_base_cost_php)}</strong> for {PORTIONS} portions,{" "}
            <span className="tabular-nums">{formatMoney(r.estimated_base_cost_php / PORTIONS)}</span> each (a baseline; your own prices take over once you shop).
          </p>
        </div>

        <Section title="Ingredients" hint={`Amounts for ${PORTIONS} portions.`}>
          <ul>{r.prep_items.map((p, i) => <Ingredient key={`${p.ingredient_id}-${i}`} item={p} />)}</ul>
        </Section>

        {cutting.length > 0 && (
          <Section title="Prep" hint="Do this before the stove is on.">
            <ul data-testid="recipe-prep">
              {cutting.map((p, i) => {
                const cut = CUT_LABELS[p.cut_technique];
                const surface = meta[p.ingredient_id]?.surface_prep;
                return (
                  <li key={`${p.ingredient_id}-${i}`} className="border-b border-line py-3 last:border-0">
                    <p className="text-[17px] font-semibold">
                      {p.cut_technique !== "NONE" ? `${cut.verb} the ${p.display_name.toLowerCase()}` : p.display_name}
                    </p>
                    {p.cut_technique !== "NONE" && (
                      <p className="text-sm text-muted">{cut.label}{cut.size ? ` · ${cut.size}` : ""}{p.cut_note ? ` · ${p.cut_note}` : ""}</p>
                    )}
                    {surface && <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-accent"><Droplets aria-hidden className="size-4" />{surface}</p>}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        <Section title="Cook" hint="Follow the cues, not a clock.">
          <ol className="flex flex-col gap-4" data-testid="recipe-steps">
            {r.cook_steps.map((step, i) => (
              <li key={i} className="flex gap-4">
                <span aria-hidden className="w-7 shrink-0 font-display text-3xl font-extrabold leading-none tabular-nums text-hot">{i + 1}</span>
                <p className="pt-0.5 text-[17px] leading-snug">{step}</p>
              </li>
            ))}
          </ol>
        </Section>

        <div className="mt-8 flex items-start gap-3 rounded-2xl bg-accent p-4 text-accent-ink">
          <Snowflake aria-hidden className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="text-xs font-semibold opacity-80">Then pack it</p>
            <p className="font-display text-xl font-bold leading-tight">{r.pack_step}</p>
          </div>
        </div>

        {r.videos.length > 0 && (
          <Section title="Videos">
            <VideoDrawer videos={r.videos} />
          </Section>
        )}

        <div className="mt-10 flex justify-end">
          <Button icon={FileJson} onClick={onEdit}>Edit JSON</Button>
        </div>
      </div>
    </Modal>
  );
}
