// Cycle date math on YYYY-MM-DD strings using UTC arithmetic only, so DST and the
// host timezone can never shift a cycle boundary. No clock access: callers pass dates in.
const MS_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type DateRange = { start: string; end: string };
export type CycleRanges = { week1: DateRange; week2: DateRange; end: string };

/** Milliseconds since epoch (UTC midnight) for a valid YYYY-MM-DD, else null. */
export function parseIsoDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null;
}

export function formatIsoDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function addDays(iso: string, days: number): string {
  const ms = parseIsoDate(iso);
  if (ms === null) throw new RangeError(`Invalid ISO date: ${iso}`);
  return formatIsoDate(ms + days * MS_DAY);
}

/** Week 1 = days 0-6, Week 2 = days 7-13. */
export function cycleRanges(startDate: string): CycleRanges {
  const week1 = { start: startDate, end: addDays(startDate, 6) };
  const week2 = { start: addDays(startDate, 7), end: addDays(startDate, 13) };
  return { week1, week2, end: week2.end };
}

function parts(iso: string): { month: number; day: number } {
  const ms = parseIsoDate(iso);
  if (ms === null) throw new RangeError(`Invalid ISO date: ${iso}`);
  const d = new Date(ms);
  return { month: d.getUTCMonth(), day: d.getUTCDate() };
}

/** "Oct 4–10" within a month, "Sep 28–Oct 4" across months. */
export function formatRange(start: string, end: string): string {
  const a = parts(start);
  const b = parts(end);
  const left = `${MONTHS[a.month]} ${a.day}`;
  return a.month === b.month ? `${left}–${b.day}` : `${left}–${MONTHS[b.month]} ${b.day}`;
}

/** "Oct 4 – Oct 17" for the top app bar. */
export function formatCycleRange(startDate: string): string {
  const a = parts(startDate);
  const b = parts(cycleRanges(startDate).end);
  return `${MONTHS[a.month]} ${a.day} – ${MONTHS[b.month]} ${b.day}`;
}
