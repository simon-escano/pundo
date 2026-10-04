import { useSyncExternalStore } from "react";

export const ROUTES = [
  { id: "plan", label: "Plan" },
  { id: "grocery", label: "Grocery" },
  { id: "day-1", label: "Day 1" },
  { id: "prep", label: "Prep" },
  { id: "cook", label: "Cook" },
  { id: "recipes", label: "Recipes" },
] as const;
export type RouteId = (typeof ROUTES)[number]["id"];

export function parseRoute(hash: string): RouteId {
  const id = hash.replace(/^#\/?/, "").split(/[?/]/)[0];
  return ROUTES.find((r) => r.id === id)?.id ?? "plan";
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export const useRoute = (): RouteId => {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  return parseRoute(hash);
};
