import { lazy, Suspense, useState } from "react";
import { AnimatePresence } from "motion/react";
import { FileJson, Plus, Search, Trash2, Undo2 } from "lucide-react";
import { PROTEIN_LABEL, SAUCE_LABEL, TIER_LABEL } from "../lib/format";
import { useApp } from "../app-context";
import { SpotlightCard } from "../components/bits/SpotlightCard";
import { AddRecipeModal } from "../components/AddRecipeModal";
import { Banner, Button, cx, Empty, IconButton, PageTitle, PROTEIN_ICON, StoveOrder, Tag } from "../components/ui";

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
      <PageTitle title="Recipes" hint={<span data-testid="recipe-count">{active}</span>} />
      <div className="relative mt-4">
        <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted" />
        <input type="search" aria-label="Search recipes" placeholder="Search recipes…" autoComplete="off" className="field !pl-11" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="mt-3 flex flex-col gap-3">
        <AnimatePresence>{saved && <Banner tone="ok" onDismiss={() => setSaved(null)}>{saved}</Banner>}</AnimatePresence>
      </div>

      <ul className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3" aria-label="Recipe library">
        {shown.map(({ recipe: r, deleted }) => {
          const Icon = PROTEIN_ICON[r.protein_category];
          return (
            <SpotlightCard as="li" key={r.id} className={cx("flex flex-col rounded-2xl border border-line bg-raised p-4 shadow-card transition-opacity duration-200", deleted && "opacity-60")} data-testid="recipe-row" data-recipe={r.id}>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-muted"><Icon aria-hidden className="size-3.5" />{PROTEIN_LABEL[r.protein_category]}</span>
              <h3 className="mt-1.5 font-semibold leading-snug">{r.name}{deleted && <Tag tone="danger">Deleted</Tag>}</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Tag tone={r.perishability_tier === "TIER_2_HARDY" ? "accent" : "neutral"}>{TIER_LABEL[r.perishability_tier]}</Tag>
                <Tag>{SAUCE_LABEL[r.sauce_base]}</Tag>
                <StoveOrder priority={r.stove_priority} />
              </div>
              <div className="mt-3 flex items-center justify-end gap-1 pt-1">
                <IconButton icon={FileJson} label={`Edit JSON for ${r.name}`} onClick={() => setEditing(r.id)} />
                {deleted
                  ? <Button icon={Undo2} onClick={() => run(() => s.recipes.restore(r.id))}>Restore</Button>
                  : <IconButton icon={Trash2} label={`Delete ${r.name}`} className="text-danger" onClick={() => run(() => s.recipes.remove(r.id))} />}
              </div>
            </SpotlightCard>
          );
        })}
      </ul>
      {shown.length === 0 && <Empty icon={Search}>No recipes match “{query}”.</Empty>}

      <Button variant="primary" icon={Plus} className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-20 h-14 rounded-2xl px-5 shadow-lift md:bottom-6" onClick={() => setAdding(true)}>
        Add recipe
      </Button>

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
