import { useMemo, useSyncExternalStore } from "react";

/** The four stages, in the order a cycle goes through them. Recipes is a library, not a stage. */
export const STAGES = [
  { id: "plan", label: "Plan" },
  { id: "grocery", label: "Grocery" },
  { id: "prep", label: "Prep" },
  { id: "cook", label: "Cook" },
] as const;
export type StageId = (typeof STAGES)[number]["id"];
export type RouteId = StageId | "recipes";

const SUBS = { prep: ["week-1", "week-2", "day-1"], cook: ["week-1", "week-2"] } as const;
export type PrepSub = (typeof SUBS.prep)[number];
export type CookSub = (typeof SUBS.cook)[number];
export type Route = { id: RouteId; sub: string | null };

export function parseRoute(hash: string): Route {
  const [id, sub] = hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
  if (id === "day-1") return { id: "prep", sub: "day-1" }; // legacy route, see canonicalHash
  if (id === "prep" || id === "cook") {
    const allowed: readonly string[] = SUBS[id];
    return { id, sub: sub && allowed.includes(sub) ? sub : "week-1" };
  }
  if (id === "grocery" || id === "recipes") return { id, sub: null };
  return { id: "plan", sub: null };
}

export const routeHref = (id: RouteId, sub?: string) => `#/${id}${sub ? `/${sub}` : ""}`;

/** `#/day-1` is the old route; it now lives under Prep. */
export const canonicalHash = (hash: string): string | null => (/^#\/?day-1(?:$|[/?])/.test(hash) ? routeHref("prep", "day-1") : null);

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export const useRoute = (): Route => {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  return useMemo(() => parseRoute(hash), [hash]);
};
