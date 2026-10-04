import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { AnimatePresence, m } from "motion/react";
import { BookOpen, Check, LogIn, LogOut } from "lucide-react";
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
  const [loggedOut, setLoggedOut] = useState(false);
  const signedOut = sync.state === "auth" || forced || loggedOut;
  const logOut = async () => {
    // Expire the Access cookie, then show the signed-out screen whether or not the request got through (offline, dev).
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    setLoggedOut(true);
    setDismissed(false);
  };

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
      <header className="sticky top-0 z-30 pt-[env(safe-area-inset-top)]" style={{ "--header-h": "calc(4rem + env(safe-area-inset-top))" } as React.CSSProperties}>
        {/* scroll-edge effect: content blurs and fades out under the controls instead of hitting a hard bar */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -bottom-6 bg-gradient-to-b from-surface via-surface/70 to-transparent backdrop-blur-xl [mask-image:linear-gradient(to_bottom,black_55%,transparent)]" />
        <div className="relative mx-auto flex h-16 max-w-5xl items-center justify-between gap-2 px-4">
          <a href={routeHref("plan")} aria-label="pundo, go to plan" className="-ml-1 inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-xl px-1"><Logo /></a>
          <div className="flex items-center gap-1">
            <SyncIndicator />
            {(sync.state !== "local" || signedOut) && <button
              type="button"
              onClick={() => (signedOut ? setDismissed(false) : void logOut())}
              className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-full px-3 text-[15px] font-semibold text-ink transition-[scale,background-color] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-ink/[0.06] active:scale-[0.97] max-[420px]:size-[44px] max-[420px]:justify-center max-[420px]:px-0"
            >
              {signedOut ? <LogIn aria-hidden className="size-[1.1rem]" strokeWidth={2.25} /> : <LogOut aria-hidden className="size-[1.1rem]" strokeWidth={2.25} />}
              <span className="max-[420px]:sr-only">{signedOut ? "Sign in" : "Log out"}</span>
            </button>}
            <a
              href={routeHref("recipes")}
              aria-current={route.id === "recipes" ? "page" : undefined}
              className={cx(
                "inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[15px] font-semibold transition-[scale,background-color,box-shadow] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.97]",
                route.id === "recipes" ? "bg-ink text-surface" : "glass-ctl text-ink",
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
 * The four stages as a floating liquid-glass progress track, centred at the bottom. It is navigation, not a wizard:
 * every stage is a link you can jump to in any order. A glass "lens" slides to the stage you are on, and the connector
 * between two stages fills once you have reached the second one.
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
  return (
    <nav
      aria-label="Main"
      className="glass fixed bottom-[calc(0.9rem+env(safe-area-inset-bottom))] left-1/2 z-40 w-[min(26rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-full p-1.5"
    >
      <ol className="flex">
        {STAGES.map((st, i) => {
          const on = active === st.id;
          const finished = done[i] && !on;
          return (
            <li key={st.id} className="group/stage relative flex-1">
              {!on && <span aria-hidden className="absolute inset-0 rounded-full bg-ink/[0.06] opacity-0 transition-opacity duration-300 group-hover/stage:opacity-100" />}
              {on && <m.span layoutId="stage-lens" className="glass-lens absolute inset-0 rounded-full" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
              {i < STAGES.length - 1 && (
                <span aria-hidden className="absolute left-[calc(50%+22px)] right-[calc(-50%+22px)] top-[21px] h-[2px] overflow-hidden rounded-full bg-ink/12">
                  <m.span className="block h-full origin-left rounded-full bg-hot" initial={false} animate={{ scaleX: i < reach ? 1 : 0 }} transition={{ type: "spring", stiffness: 200, damping: 30 }} />
                </span>
              )}
              <a
                href={routeHref(st.id)}
                aria-current={on ? "page" : undefined}
                data-done={done[i] || undefined}
                className={cx("relative z-10 flex min-h-[56px] flex-col items-center gap-1 pt-2 text-[11.5px] font-semibold transition-colors duration-150", on ? "text-ink" : "text-ink/60 hover:text-ink")}
              >
                <span
                  aria-hidden
                  className={cx(
                    "grid size-7 place-items-center rounded-full font-display text-[13px] font-extrabold transition-[background-color,box-shadow] duration-200",
                    on
                      ? "bg-accent text-accent-ink shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_22%,transparent)]"
                      : finished
                        ? "bg-ink text-surface"
                        : "text-ink/60 ring-[1.5px] ring-inset ring-ink/25",
                  )}
                >
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
