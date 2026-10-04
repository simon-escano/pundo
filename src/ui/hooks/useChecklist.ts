import { useCallback, useSyncExternalStore } from "react";

// Per-device convenience state (prep / Day 1 / cook ticks). localStorage only; every access is guarded
// because private windows and blocked storage can throw. The UI works identically without persistence.
const cache = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
const KEY = (k: string) => `pundo:check:${k}`;

function read(key: string): readonly string[] {
  const hit = cache.get(key);
  if (hit) return hit;
  let v: string[] = [];
  try {
    const raw = localStorage.getItem(KEY(key));
    if (raw) v = (JSON.parse(raw) as unknown[]).filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore */
  }
  cache.set(key, v);
  return v;
}

function write(key: string, v: readonly string[]): void {
  cache.set(key, v);
  try {
    localStorage.setItem(KEY(key), JSON.stringify(v));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

export function useChecklist(key: string): { checked: ReadonlySet<string>; toggle: (id: string) => void; list: readonly string[] } {
  const list = useSyncExternalStore(subscribe, () => read(key), () => []);
  const toggle = useCallback(
    (id: string) => {
      const cur = read(key);
      write(key, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
    },
    [key],
  );
  return { checked: new Set(list), toggle, list };
}
