import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { AnimatePresence, m } from "motion/react";
import { BookOpen, Check } from "lucide-react";
import { AppProvider, useApp } from "./app-context";
import { EASE_OUT, MotionProvider } from "./motion";
import { canonicalHash, routeHref, STAGES, useRoute, type RouteId } from "./router";
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
      <a href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }} className="fixed left-3 top-3 z-[70] inline-flex min-h-[44px] -translate-y-24 items-center rounded-xl bg-raised px-4 text-sm font-semibold shadow-float transition-transform duration-150 focus:translate-y-0">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 bg-surface/90 pt-[env(safe-area-inset-top)] backdrop-blur-md" style={{ "--header-h": "calc(4rem + env(safe-area-inset-top))" } as React.CSSProperties}>
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-2 px-4">
          <a href={routeHref("plan")} aria-label="pundo, go to plan" className="-ml-1 inline-flex min-h-[44px] items-center rounded-xl px-1"><Logo /></a>
          <div className="flex items-center gap-1">
            <SyncIndicator onSignIn={() => setDismissed(false)} />
            <a
              href={routeHref("recipes")}
              aria-current={route.id === "recipes" ? "page" : undefined}
              className={cx(
                "inline-flex min-h-[44px] items-center gap-2 rounded-full px-3.5 text-[15px] font-semibold transition-colors duration-150",
                route.id === "recipes" ? "bg-ink text-surface" : "text-ink ring-1 ring-inset ring-ink/25 hover:bg-sunken",
              )}
            >
              <BookOpen aria-hidden className="size-[1.1rem]" strokeWidth={2.25} />
              Recipes
            </a>
          </div>
        </div>
      </header>

      <UpdatePrompt />
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 pb-40 pt-4 outline-none" data-route={route.id}>
        <AnimatePresence mode="wait" initial={false}>
          <m.div key={route.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE_OUT }}>
            <Suspense fallback={<ViewLoading />}>
              <View />
            </Suspense>
          </m.div>
        </AnimatePresence>
      </main>
      <StageBar active={route.id} />

      <AnimatePresence>{signedOut && !dismissed && <SignInScreen onDismiss={() => setDismissed(true)} />}</AnimatePresence>
    </>
  );
}

/**
 * The four stages as a floating progress track, centred at the bottom. It is navigation, not a wizard: every stage is a
 * link you can jump to in any order. The line fills up to the furthest stage you are on or have finished.
 */
function StageBar({ active }: { active: RouteId }) {
  const { cycle, derived } = useApp();
  const done: boolean[] = [
    cycle.status !== "draft",
    !!derived.grocery && derived.grocery.lines.length > 0 && derived.grocery.lines.every((l) => l.bought),
    false,
    false,
  ];
  const activeIdx = STAGES.findIndex((st) => st.id === active);
  const reach = Math.max(activeIdx, done.lastIndexOf(true));
  const progress = reach <= 0 ? 0 : reach / (STAGES.length - 1);
  return (
    <nav
      aria-label="Main"
      className="fixed bottom-[calc(0.9rem+env(safe-area-inset-bottom))] left-1/2 z-40 w-[min(27rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-full bg-bar px-2 py-1.5 text-bar-ink shadow-float"
    >
      <ol className="relative flex">
        <li aria-hidden className="pointer-events-none absolute left-[12.5%] right-[12.5%] top-[19px] h-0.5 rounded-full bg-bar-ink/20">
          <m.span className="absolute inset-0 origin-left rounded-full bg-hot" initial={false} animate={{ scaleX: progress }} transition={{ type: "spring", stiffness: 220, damping: 32 }} />
        </li>
        {STAGES.map((st, i) => {
          const on = active === st.id;
          const finished = done[i] && !on;
          return (
            <li key={st.id} className="relative flex-1">
              <a
                href={routeHref(st.id)}
                aria-current={on ? "page" : undefined}
                data-done={done[i] || undefined}
                className={cx("flex min-h-[56px] flex-col items-center gap-1 pt-1.5 text-[11px] font-semibold tracking-wide transition-colors duration-150", on ? "text-bar-ink" : "text-bar-ink/65 hover:text-bar-ink")}
              >
                <span
                  aria-hidden
                  className={cx(
                    "relative z-10 grid size-7 place-items-center rounded-full font-display text-[13px] font-extrabold transition-colors duration-200",
                    on ? "bg-hot text-bar" : finished ? "bg-ok text-white" : "bg-bar ring-2 ring-inset ring-bar-ink/30",
                  )}
                >
                  {on && <m.span layoutId="stage-halo" className="absolute -inset-1.5 -z-10 rounded-full bg-hot/30" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
                  {finished ? <Check className="size-4" strokeWidth={3.5} /> : i + 1}
                </span>
                {st.label}
              </a>
            </li>
          );
        })}
      </ol>
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
