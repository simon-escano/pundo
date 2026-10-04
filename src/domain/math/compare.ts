// Locale-independent ordering (String#localeCompare is banned in domain).
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type Cmp<T> = (a: T, b: T) => number;

/** Compose comparators: first non-zero wins. */
export function compareBy<T>(...cmps: Cmp<T>[]): Cmp<T> {
  return (a, b) => {
    for (const c of cmps) {
      const r = c(a, b);
      if (r !== 0) return r;
    }
    return 0;
  };
}
