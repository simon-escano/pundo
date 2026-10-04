import { lazy, Suspense, useState } from "react";
import { AnimatePresence } from "motion/react";
import { FileJson, Plus, Search, Trash2, Undo2 } from "lucide-react";
import { PROTEIN_LABEL, SAUCE_LABEL, TIER_LABEL } from "../lib/format";
import { useApp } from "../app-context";
import { SpotlightCard } from "../components/bits/SpotlightCard";
import { AddRecipeModal } from "../components/AddRecipeModal";
import { Banner, Button, cx, Empty, IconButton, PageTitle, PROTEIN_ICON, PROTEIN_TINT, StoveOrder, Tag } from "../components/ui";

// The raw JSON editor is rarely opened, so it loads on demand.
const JsonEditorModal = lazy(() => import("../components/JsonEditorModal").then((m) => ({ default: m.JsonEditorModal })));

export function RecipesView() {
  const { s, world, run } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const active = world.recipes.filter((r) => !r.deleted).length;
  const q = query.trim().toLowerCase();
  const shown = world.recipes.filter(({ recipe }) => recipe.name.toLowerCase().includes(q));

  return (
    <div>
      <PageTitle title="Recipes" hint={<><span data-testid="recipe-count">{active}</span> in your library</>}>
        <Button variant="primary" icon={Plus} className="shrink-0" onClick={() => setAdding(true)}>Add recipe</Button>
      </PageTitle>
      <div className="relative mt-6">
        <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted" />
        <input type="search" aria-label="Search recipes" placeholder="Search recipes…" autoComplete="off" className="field !rounded-full !pl-12" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <AnimatePresence>{saved && <div className="mt-4"><Banner tone="ok" onDismiss={() => setSaved(null)}>{saved}</Banner></div>}</AnimatePresence>

      <ul className="mt-6 grid gap-3 md:grid-cols-2 lg:grid-cols-3" aria-label="Recipe library">
        {shown.map(({ recipe: r, deleted }) => {
          const Icon = PROTEIN_ICON[r.protein_category];
          return (
            <SpotlightCard as="li" key={r.id} className={cx("flex min-h-40 flex-col rounded-2xl p-4 transition-opacity duration-200", PROTEIN_TINT[r.protein_category], deleted && "opacity-55")} data-testid="recipe-row" data-recipe={r.id}>
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink/70"><Icon aria-hidden className="size-4" strokeWidth={2.25} />{PROTEIN_LABEL[r.protein_category]}</span>
              <h3 className="mt-2 font-display text-xl font-bold leading-[1.1]">{r.name}{deleted && <> <Tag tone="danger">Deleted</Tag></>}</h3>
              <p className="mt-2 text-sm text-ink/75">{TIER_LABEL[r.perishability_tier]} · {SAUCE_LABEL[r.sauce_base]}</p>
              <div className="mt-auto flex items-end justify-between gap-2 pt-4">
                <StoveOrder priority={r.stove_priority} />
                <div className="flex items-center gap-1">
                  <IconButton icon={FileJson} variant="secondary" label={`Edit JSON for ${r.name}`} onClick={() => setEditing(r.id)} />
                  {deleted
                    ? <Button icon={Undo2} onClick={() => run(() => s.recipes.restore(r.id))}>Restore</Button>
                    : <IconButton icon={Trash2} variant="secondary" label={`Delete ${r.name}`} className="text-danger" onClick={() => run(() => s.recipes.remove(r.id))} />}
                </div>
              </div>
            </SpotlightCard>
          );
        })}
      </ul>
      {shown.length === 0 && <Empty icon={Search}>No recipes match “{query}”.</Empty>}

      <AnimatePresence>{adding && <AddRecipeModal onClose={() => setAdding(false)} onSaved={setSaved} />}</AnimatePresence>
      <AnimatePresence>
        {editing && (
          <Suspense fallback={null}>
            <JsonEditorModal recipeId={editing} onClose={() => setEditing(null)} />
          </Suspense>
        )}
      </AnimatePresence>
    </div>
  );
}
