/** UUIDv7: 48-bit ms timestamp + random bits, so ids sort by creation time. */
export function uuidv7(nowMs: number, randomBytes: (n: number) => Uint8Array): string {
  const b = randomBytes(16);
  const ts = BigInt(Math.floor(nowMs));
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const cryptoRandomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
