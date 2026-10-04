import { lazy, Suspense, type ComponentType } from "react";
import { AppProvider } from "./app-context";
import { ROUTES, useRoute, type RouteId } from "./router";
import { SyncIndicator } from "./components/SyncIndicator";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { GroceryView } from "./views/GroceryView";
import { PlanView } from "./views/PlanView";

// Plan and Grocery are the daily-use screens and stay in the entry chunk. Everything else is split out
// (and precached by the service worker, so it still opens offline).
const lazyView = (load: () => Promise<Record<string, ComponentType>>, name: string) =>
  lazy(() => load().then((m) => ({ default: m[name]! })));
const Day1View = lazyView(() => import("./views/Day1View"), "Day1View");
const PrepBoardView = lazyView(() => import("./views/PrepBoardView"), "PrepBoardView");
const CookView = lazyView(() => import("./views/CookView"), "CookView");
const RecipesView = lazyView(() => import("./views/RecipesView"), "RecipesView");

const VIEWS: Record<RouteId, ComponentType> = {
  plan: PlanView,
  grocery: GroceryView,
  "day-1": Day1View,
  prep: PrepBoardView,
  cook: CookView,
  recipes: RecipesView,
};

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const route = useRoute();
  const View = VIEWS[route];
  return (
    <>
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 pt-2">
        <span className="text-xs font-extrabold uppercase tracking-wide muted">Meal Prep Engine</span>
        <SyncIndicator />
      </header>
      <UpdatePrompt />
      <main className="mx-auto max-w-5xl px-3 pb-44 pt-2" data-route={route}>
        <Suspense fallback={<ViewLoading />}>
          <View />
        </Suspense>
      </main>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 flex border-t-2 border-ink bg-white">
        {ROUTES.map((r) => (
          <a
            key={r.id}
            href={`#/${r.id}`}
            aria-current={route === r.id ? "page" : undefined}
            className={`flex min-h-14 flex-1 items-center justify-center px-0.5 text-center text-xs font-extrabold ${route === r.id ? "bg-ink text-white" : "text-ink"}`}
          >
            {r.label}
          </a>
        ))}
      </nav>
    </>
  );
}

/** Shown only while a split-out view's chunk loads (instant when precached). */
function ViewLoading() {
  return <p className="muted p-4" role="status" aria-busy="true" data-testid="view-loading">Loading…</p>;
}
