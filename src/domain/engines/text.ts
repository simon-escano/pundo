// Tiny deterministic English helpers for display strings.
const PLAIN_S_AFTER_O = new Set(["avocado", "taco", "kilo", "burrito", "tostado"]);

export function pluralize(noun: string, count: number): string {
  if (count === 1) return noun;
  const last = noun.slice(noun.lastIndexOf(" ") + 1);
  if (PLAIN_S_AFTER_O.has(last)) return `${noun}s`;
  if (/(?:[^aeiou]o|s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/** "600g", "250ml" attach to the number; counted units get a space ("1 pack", "10 pc"). */
export function joinQty(quantity: number, unit: string): string {
  return unit === "g" || unit === "ml" ? `${quantity}${unit}` : `${quantity} ${unit}`;
}
