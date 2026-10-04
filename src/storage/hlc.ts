import { compareStrings } from "../domain/math/compare";

// Hybrid Logical Clock: "<wall ms, 15 digits>-<counter, 5 digits>-<deviceId>".
// Fixed-width fields make plain string comparison equal to causal order; deviceId breaks exact ties.
export type HlcState = { wall: number; counter: number };

const WALL_WIDTH = 15;
const COUNTER_WIDTH = 5;
const MAX_COUNTER = 99_999;

export { SEED_HLC } from "../domain/sync/protocol";

export function formatHlc(s: HlcState, deviceId: string): string {
  return `${String(s.wall).padStart(WALL_WIDTH, "0")}-${String(s.counter).padStart(COUNTER_WIDTH, "0")}-${deviceId}`;
}

export function parseHlc(h: string): (HlcState & { deviceId: string }) | null {
  const m = /^(\d{15})-(\d{5})-(.+)$/.exec(h);
  return m ? { wall: Number(m[1]), counter: Number(m[2]), deviceId: m[3]! } : null;
}

export const compareHlc = compareStrings;

export class HlcClock {
  private wall: number;
  private counter: number;

  constructor(
    readonly deviceId: string,
    private readonly now: () => number,
    initial: HlcState = { wall: 0, counter: 0 },
  ) {
    this.wall = initial.wall;
    this.counter = initial.counter;
  }

  state(): HlcState {
    return { wall: this.wall, counter: this.counter };
  }

  /** Local event or send: strictly greater than every stamp this clock has produced or received. */
  tick(): string {
    const pt = this.now();
    if (pt > this.wall) {
      this.wall = pt;
      this.counter = 0;
    } else {
      this.bump();
    }
    return formatHlc(this.state(), this.deviceId);
  }

  /** Merge a remote stamp so later local stamps sort after it. */
  receive(remote: string): string {
    const r = parseHlc(remote);
    if (!r) throw new RangeError(`Invalid HLC: ${remote}`);
    const pt = this.now();
    const wall = Math.max(this.wall, r.wall, pt);
    if (wall === this.wall && wall === r.wall) this.counter = Math.max(this.counter, r.counter) + 1;
    else if (wall === this.wall) this.counter += 1;
    else if (wall === r.wall) this.counter = r.counter + 1;
    else this.counter = 0;
    this.wall = wall;
    if (this.counter > MAX_COUNTER) throw new RangeError("HLC counter overflow");
    return formatHlc(this.state(), this.deviceId);
  }

  private bump(): void {
    this.counter += 1;
    if (this.counter > MAX_COUNTER) throw new RangeError("HLC counter overflow");
  }
}
