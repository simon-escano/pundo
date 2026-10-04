import { useState } from "react";
import { buildLlmPrompt } from "../../domain/ingest/llmPrompt";
import { IngredientPriceRecordSchema } from "../../domain/schemas/blueprint";
import { AisleEnum, StorageClassEnum } from "../../domain/schemas/app";
import type { IngestPreview, IngredientAction, IngredientResolution } from "../../storage/ingest";
import { useApp } from "../app-context";
import { Banner } from "./ui";

const PRICING_UNITS = IngredientPriceRecordSchema.shape.pricing_unit.options;
type Edit = Partial<IngredientResolution> & { priceText?: string };

/** Paste JSON → validate → resolve new ingredients inline → save. No wizard: everything is on one screen. */
export function IngestPanel() {
  const { s, run } = useApp();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<IngestPreview | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [missing, setMissing] = useState<Record<string, string[]>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const resolutionFor = (a: IngredientAction): IngredientResolution => {
    const e = edits[a.ingredient_id] ?? {};
    const price = e.priceText?.trim() ? Number(e.priceText) : undefined;
    const pricing_unit = e.pricing_unit ?? a.suggestedPricingUnit ?? undefined;
    return { ...e, ingredient_id: a.ingredient_id, ...(pricing_unit ? { pricing_unit } : {}), ...(price !== undefined && Number.isFinite(price) ? { price } : {}) };
  };
  const setEdit = (id: string, patch: Edit) => setEdits({ ...edits, [id]: { ...edits[id], ...patch } });
  const invalid = (id: string, field: string) => missing[id]?.includes(field) === true;

  const copyPrompt = () =>
    run(async () => {
      const ids = Object.keys((await s.registry.snapshot()));
      try {
        await navigator.clipboard.writeText(buildLlmPrompt(ids));
        setMsg({ tone: "ok", text: "Copied schema & prompt. Paste it into Gemini with your recipe link." });
      } catch {
        setMsg({ tone: "warn", text: "Clipboard blocked by the browser. Long-press the box below to copy manually." });
      }
    });

  const check = () => run(async () => { setMsg(null); setMissing({}); setPreview(await s.ingest.preview(text)); });
  const save = () =>
    run(async () => {
      if (!preview?.ok) return;
      const res = await s.ingest.commit(text, preview.actions.map(resolutionFor));
      if (res.ok) {
        setMsg({ tone: "ok", text: `Saved “${res.recipe.name}”${res.created ? "" : " (updated)"}. It is now in the roller pool.` });
        setText(""); setPreview(null); setEdits({}); setMissing({});
      } else if (res.code === "UNRESOLVED_INGREDIENTS") {
        setMissing(res.missingFields);
        setMsg({ tone: "warn", text: "Fill the highlighted fields for each new ingredient." });
      } else {
        setPreview({ ok: false, errors: res.errors, warnings: res.warnings });
      }
    });

  return (
    <section className="card" aria-label="Add recipe">
      <h2 className="text-lg font-extrabold">Add recipe</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn" onClick={copyPrompt}>Copy Schema &amp; LLM Prompt</button>
      </div>
      {msg && <div className="mt-2"><Banner tone={msg.tone}>{msg.text}</Banner></div>}
      <label htmlFor="recipe-json" className="mt-3 block text-sm font-bold">Recipe JSON from Gemini</label>
      <textarea id="recipe-json" className="field" rows={8} spellCheck={false} placeholder='{"id": "…", "name": "…", …}' value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} />
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={text.trim() === ""} onClick={check}>Check Recipe</button>
        <button className="btn btn-primary" disabled={!preview?.ok} onClick={save}>Save Recipe</button>
      </div>

      {preview && !preview.ok && (
        <div className="mt-2" data-testid="ingest-errors">
          <Banner title={`${preview.errors.length} problem${preview.errors.length === 1 ? "" : "s"} to fix`}>
            <ul className="list-disc pl-5">{preview.errors.map((e, i) => <li key={i}><code>{e.path}</code>: {e.message}</li>)}</ul>
          </Banner>
        </div>
      )}
      {preview?.ok && (
        <div className="mt-2 flex flex-col gap-2" data-testid="ingest-ok">
          <Banner tone="ok">Valid: {preview.recipe.name}{preview.willUpdate ? " (will update the existing recipe)" : ""}</Banner>
          {preview.warnings.length > 0 && (
            <Banner tone="warn"><ul className="list-disc pl-5">{preview.warnings.map((w, i) => <li key={i}><code>{w.path}</code>: {w.message}</li>)}</ul></Banner>
          )}
          {preview.actions.map((a) => {
            const e = edits[a.ingredient_id] ?? {};
            return (
              <fieldset key={a.ingredient_id} className="rounded-lg border-2 border-accent p-2" data-testid="new-ingredient" data-ingredient={a.ingredient_id}>
                <legend className="px-1 text-sm font-extrabold">New Ingredient Detected: “{a.display_name}”</legend>
                <div className="grid grid-cols-2 gap-2">
                  {a.needsPrice && (
                    <>
                      <label className="text-xs font-bold">Pricing unit
                        <select className="field" aria-invalid={invalid(a.ingredient_id, "pricing_unit")} value={e.pricing_unit ?? a.suggestedPricingUnit ?? ""} onChange={(ev) => setEdit(a.ingredient_id, { pricing_unit: ev.target.value as IngredientResolution["pricing_unit"] })}>
                          <option value="">Choose…</option>
                          {PRICING_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-bold">Unit price ₱ (optional)
                        <input className="field" type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={e.priceText ?? ""} onChange={(ev) => setEdit(a.ingredient_id, { priceText: ev.target.value })} />
                      </label>
                    </>
                  )}
                  {a.needsMeta && (
                    <>
                      <label className="text-xs font-bold">Aisle (required)
                        <select className="field" aria-invalid={invalid(a.ingredient_id, "aisle")} value={e.aisle ?? ""} onChange={(ev) => setEdit(a.ingredient_id, { aisle: ev.target.value as IngredientResolution["aisle"] })}>
                          <option value="">Choose…</option>
                          {AisleEnum.options.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-bold">Storage class (required)
                        <select className="field" aria-invalid={invalid(a.ingredient_id, "storage_class")} value={e.storage_class ?? ""} onChange={(ev) => setEdit(a.ingredient_id, { storage_class: ev.target.value as IngredientResolution["storage_class"] })}>
                          <option value="">Choose…</option>
                          {StorageClassEnum.options.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </label>
                      <label className="col-span-2 text-xs font-bold">Surface prep (optional)
                        <input className="field" placeholder="Wash and peel" value={e.surface_prep ?? ""} onChange={(ev) => setEdit(a.ingredient_id, { surface_prep: ev.target.value || null })} />
                      </label>
                    </>
                  )}
                </div>
              </fieldset>
            );
          })}
        </div>
      )}
    </section>
  );
}
