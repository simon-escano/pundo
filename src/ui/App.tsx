import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { AnimatePresence, m } from "motion/react";
import { ArrowLeft, BookOpen, CalendarRange, Check, Flame, ShoppingBasket, Soup, type LucideIcon } from "lucide-react";
import { AppProvider, useApp } from "./app-context";
import { EASE_OUT, MotionProvider } from "./motion";
import { canonicalHash, routeHref, STAGES, useRoute, type RouteId, type StageId } from "./router";
import { Logo } from "./components/Logo";
import { SignInScreen } from "./components/SignInScreen";
import { SyncIndicator, useSyncIndicator } from "./components/SyncIndicator";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { cx } from "./components/ui";
import { forcedSignIn } from "./fixtureFlags";
import { GroceryView } from "./views/GroceryView";
import { PlanView } from "./views/PlanView";

// Plan and Grocery are the daily-use screens and stay in the entry chunk. Everything else is split out
// (and precached by the service worker, so it still opens offline).
const lazyView = (load: () => Promise<Record<string, ComponentType>>, name: string) =>
  lazy(() => load().then((m) => ({ default: m[name]! })));
const PrepView = lazyView(() => import("./views/PrepView"), "PrepView");
const CookView = lazyView(() => import("./views/CookView"), "CookView");
const RecipesView = lazyView(() => import("./views/RecipesView"), "RecipesView");

const VIEWS: Record<RouteId, ComponentType> = { plan: PlanView, grocery: GroceryView, prep: PrepView, cook: CookView, recipes: RecipesView };
const TITLES: Record<RouteId, string> = { plan: "Plan", grocery: "Grocery", prep: "Prep", cook: "Cook", recipes: "Recipes" };
const STAGE_ICON: Record<StageId, LucideIcon> = { plan: CalendarRange, grocery: ShoppingBasket, prep: Soup, cook: Flame };

export function App() {
  return (
    <MotionProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </MotionProvider>
  );
}

function Shell() {
  const route = useRoute();
  const View = VIEWS[route.id];
  const sync = useSyncIndicator();
  const [dismissed, setDismissed] = useState(false);
  const forced = forcedSignIn(window.location);
  const signedOut = sync.state === "auth" || forced;

  useEffect(() => {
    const next = canonicalHash(window.location.hash);
    if (!next) return;
    window.history.replaceState(null, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, [route]);
  useEffect(() => {
    document.title = `${TITLES[route.id]} · pundo`;
  }, [route.id]);
  if (!signedOut && dismissed) setDismissed(false);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.id]);

  return (
    <>
      <a href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }} className="fixed left-3 top-3 z-[70] inline-flex min-h-[44px] -translate-y-24 items-center rounded-xl bg-raised px-4 text-sm font-semibold shadow-lift transition-transform duration-150 focus:translate-y-0">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/85 pt-[env(safe-area-inset-top)] backdrop-blur-md" style={{ "--header-h": "calc(3.5rem + env(safe-area-inset-top))" } as React.CSSProperties}>
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 px-4">
          {route.id === "recipes" ? (
            <a href={routeHref("plan")} className="-ml-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-2 text-sm font-semibold hover:bg-sunken">
              <ArrowLeft aria-hidden className="size-5" />
              Back to plan
            </a>
          ) : (
            <a href={routeHref("plan")} aria-label="pundo, go to plan" className="-ml-1 inline-flex min-h-[44px] items-center rounded-xl px-1"><Logo /></a>
          )}
          <div className="flex items-center gap-1">
            <SyncIndicator onSignIn={() => setDismissed(false)} />
            {route.id !== "recipes" && (
              <a href={routeHref("recipes")} aria-label="Recipes" title="Recipes" className="grid size-[44px] place-items-center rounded-xl transition-colors duration-150 hover:bg-sunken">
                <BookOpen aria-hidden className="size-5" />
              </a>
            )}
          </div>
        </div>
      </header>

      <UpdatePrompt />
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 pb-44 pt-5 outline-none md:pb-20" data-route={route.id}>
        <AnimatePresence mode="wait" initial={false}>
          <m.div key={route.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE_OUT }}>
            <Suspense fallback={<ViewLoading />}>
              <View />
            </Suspense>
          </m.div>
        </AnimatePresence>
      </main>
      <MainNav active={route.id} />

      <AnimatePresence>{signedOut && !dismissed && <SignInScreen onDismiss={() => setDismissed(true)} />}</AnimatePresence>
    </>
  );
}

/** One nav, two shapes: a bottom tab bar on phones, a centred segmented bar in the header from `md` up. */
function MainNav({ active }: { active: RouteId }) {
  const { cycle, derived } = useApp();
  const done: Partial<Record<StageId, boolean>> = {
    plan: cycle.status !== "draft",
    grocery: !!derived.grocery && derived.grocery.lines.length > 0 && derived.grocery.lines.every((l) => l.bought),
  };
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-raised/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:inset-x-auto md:bottom-auto md:left-1/2 md:top-[calc(env(safe-area-inset-top)+1px)] md:w-max md:-translate-x-1/2 md:rounded-2xl md:border md:bg-sunken md:pb-0"
    >
      <ul className="flex md:gap-1 md:p-1">
        {STAGES.map((st) => {
          const on = active === st.id;
          const Icon = STAGE_ICON[st.id];
          return (
            <li key={st.id} className="flex-1">
              <a
                href={routeHref(st.id)}
                aria-current={on ? "page" : undefined}
                className={cx(
                  "relative flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-2xl whitespace-nowrap text-xs font-semibold transition-colors duration-150 md:min-h-[44px] md:flex-row md:gap-2 md:px-5 md:text-sm",
                  on ? "text-accent md:text-ink" : "text-muted hover:text-ink",
                )}
              >
                {on && <m.span layoutId="nav-pill" className="absolute inset-x-3 inset-y-1.5 rounded-2xl bg-accent-soft md:inset-0 md:rounded-xl md:bg-raised md:shadow-card" transition={{ type: "spring", stiffness: 480, damping: 36 }} />}
                <span className="relative">
                  <Icon aria-hidden className="size-[1.35rem] md:size-[1.1rem]" strokeWidth={on ? 2.4 : 2} />
                  {done[st.id] && <Check aria-hidden className="absolute -right-2 -top-1.5 size-3.5 rounded-full bg-accent p-0.5 text-accent-ink" strokeWidth={4} />}
                </span>
                <span className="relative">{st.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Shown only while a split-out view's chunk loads (instant when precached). */
function ViewLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" data-testid="view-loading" className="flex flex-col gap-3">
      <div className="h-8 w-40 animate-pulse rounded-xl bg-sunken" />
      <div className="h-32 animate-pulse rounded-2xl bg-sunken" />
      <div className="h-32 animate-pulse rounded-2xl bg-sunken" />
    </div>
  );
}
