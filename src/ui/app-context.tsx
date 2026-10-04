import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { AnimatePresence } from "motion/react";
import type { Cycle } from "../domain/schemas/app";
import { createStorage, type Storage } from "../storage";
import type { SyncEngine } from "../storage/sync";
import { StorageError } from "../storage/errors";
import { ensureCycle } from "./lib/actions";
import { derive, type Derived } from "./lib/derive";
import { loadWorld, type World } from "./lib/world";
import { createFixtureStorage, fixtureFromLocation } from "./fixture";
import { requestPersistentStorage } from "./persist";
import { Banner } from "./components/ui";
import { LogoMark } from "./components/Logo";

let storagePromise: Promise<Storage> | null = null;
let syncEngine: SyncEngine | null = null;
/** One storage instance per page load (StrictMode-safe). */
export function getStorage(): Promise<Storage> {
  storagePromise ??= (async () => {
    const fixture = fixtureFromLocation(window.location);
    if (fixture) return createFixtureStorage(fixture);
    void requestPersistentStorage(); // protect IndexedDB from browser eviction; best effort
    const s = await createStorage();
    await ensureCycle(s);
    // Edge sync: production builds, or opt in locally with VITE_ENABLE_SYNC=true (needs `npm run worker:dev`).
    // Off in dev/fixtures so tests never depend on a backend. It never throws into the UI; failures just back off.
    if (import.meta.env.PROD || import.meta.env.VITE_ENABLE_SYNC === "true") {
      syncEngine = s.sync();
      syncEngine.start();
    }
    return s;
  })();
  return storagePromise;
}

export type AppData = {
  s: Storage;
  /** The running sync engine, or null when sync is off (dev, fixtures). */
  sync: SyncEngine | null;
  world: World;
  derived: Derived;
  cycle: Cycle;
  /** Run an action; failures become a dismissible alert instead of an unhandled rejection. */
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
};
const Ctx = createContext<AppData | null>(null);
export const useApp = (): AppData => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
};

function describeError(e: unknown): string {
  if (e instanceof StorageError) {
    const detail = e.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    return detail ? `${e.message} ${detail}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<Storage | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getStorage().then(
      (st) => alive && setS(st),
      (e) => alive && setFatal(describeError(e)),
    );
    return () => {
      alive = false;
    };
  }, []);

  if (fatal) return <div className="mx-auto max-w-md p-6"><Banner title="Storage failed to open">{fatal}</Banner></div>;
  if (!s) return <Splash />;
  return (
    <WorldProvider s={s} error={error} setError={setError}>
      {children}
    </WorldProvider>
  );
}

function WorldProvider({ s, error, setError, children }: { s: Storage; error: string | null; setError: (e: string | null) => void; children: ReactNode }) {
  const world = useLiveQuery(() => loadWorld(s), [s]);
  const derived = useMemo(() => (world ? derive(world) : null), [world]);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>) => {
      try {
        setError(null);
        return await fn();
      } catch (e) {
        setError(describeError(e));
        return undefined;
      }
    },
    [setError],
  );
  if (!world || !derived || !world.cycle) return <Splash />;
  return (
    <Ctx.Provider value={{ s, sync: syncEngine, world, derived, cycle: world.cycle, run }}>
      <div className="fixed inset-x-4 top-[calc(4rem+env(safe-area-inset-top))] z-50 mx-auto max-w-xl">
        <AnimatePresence>{error && <Banner onDismiss={() => setError(null)}>{error}</Banner>}</AnimatePresence>
      </div>
      {children}
    </Ctx.Provider>
  );
}

/** First paint while IndexedDB opens: the mark, so the page is never blank. */
function Splash() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="grid min-h-dvh place-items-center">
      <LogoMark className="size-14 animate-pulse" />
    </div>
  );
}
