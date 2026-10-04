import { lazy, Suspense, useState } from "react";
import { PROTEIN_LABEL, SAUCE_LABEL, TIER_LABEL } from "../lib/format";
import { useApp } from "../app-context";
import { IngestPanel } from "../components/IngestPanel";
import { StoveBadge } from "../components/ui";

// The raw JSON editor is rarely opened, so it loads on demand.
const JsonEditorModal = lazy(() => import("../components/JsonEditorModal").then((m) => ({ default: m.JsonEditorModal })));

export function RecipesView() {
  const { s, world, run } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const active = world.recipes.filter((r) => !r.deleted).length;
  return (
    <div>
      <h1 className="text-xl font-extrabold">Recipes</h1>
      <div className="mt-2"><IngestPanel /></div>
      <section className="mt-4" aria-label="Recipe library">
        <h2 className="sticky-head border-b-2 border-ink py-2 text-lg font-extrabold">Library ({active})</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {world.recipes.map(({ recipe: r, deleted }) => (
            <li key={r.id} className={`card ${deleted ? "opacity-60" : ""}`} data-testid="recipe-row" data-recipe={r.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-extrabold">{r.name}{deleted && <span className="chip ml-2">deleted</span>}</h3>
                <div className="flex gap-2">
                  <button className="btn" aria-label={`Edit JSON for ${r.name}`} onClick={() => setEditing(r.id)}>Edit JSON</button>
                  {deleted
                    ? <button className="btn" onClick={() => run(() => s.recipes.restore(r.id))}>Restore</button>
                    : <button className="btn btn-danger" aria-label={`Delete ${r.name}`} onClick={() => run(() => s.recipes.remove(r.id))}>Delete</button>}
                </div>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <span className="chip">{PROTEIN_LABEL[r.protein_category]}</span>
                <span className="chip">{TIER_LABEL[r.perishability_tier]}</span>
                <span className="chip">{SAUCE_LABEL[r.sauce_base]}</span>
                <StoveBadge priority={r.stove_priority} />
              </div>
            </li>
          ))}
        </ul>
      </section>
      {editing && (
        <Suspense fallback={null}>
          <JsonEditorModal recipeId={editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
    </div>
  );
}
