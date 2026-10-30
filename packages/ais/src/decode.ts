/**
 * Minimal ITU-R M.1371 decoder for the message types the gateway needs:
 *   1/2/3  Class A position report
 *   18     Class B position report
 *   5      Class A static & voyage data
 *   24     Class B static data (parts A and B)
 * Everything else is ignored (returns null).
 */

export interface PositionReport {
  type: 1 | 2 | 3 | 18;
  mmsi: number;
  navStatus?: number;
  sog?: number;
  lon?: number;
  lat?: number;
  cog?: number;
  heading?: number;
  second?: number;
}

export interface StaticReport {
  type: 5 | 24;
  mmsi: number;
  imo?: number;
  callsign?: string;
  name?: string;
  shipType?: number;
  lengthM?: number;
  beamM?: number;
  draughtM?: number;
  destination?: string;
}

export type AisMessage = PositionReport | StaticReport;

class BitReader {
  readonly length: number;
  private readonly bits: Uint8Array;

  constructor(payload: string, fillBits: number) {
    const bits = new Uint8Array(payload.length * 6);
    for (let i = 0; i < payload.length; i++) {
      let v = payload.charCodeAt(i) - 48;
      if (v > 40) v -= 8;
      if (v < 0 || v > 63) throw new Error("invalid armoring");
      for (let b = 0; b < 6; b++) bits[i * 6 + b] = (v >> (5 - b)) & 1;
    }
    this.bits = bits;
    this.length = bits.length - fillBits;
  }

  has(start: number, len: number) {
    return start + len <= this.length;
  }

  uint(start: number, len: number): number {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 2 + (this.bits[start + i] ?? 0);
    return v;
  }

  int(start: number, len: number): number {
    const v = this.uint(start, len);
    return this.bits[start] ? v - 2 ** len : v;
  }

  text(start: number, len: number): string {
    let s = "";
    const chars = Math.floor(len / 6);
    for (let i = 0; i < chars; i++) {
      if (!this.has(start + i * 6, 6)) break;
      const c = this.uint(start + i * 6, 6);
      s += String.fromCharCode(c < 32 ? c + 64 : c);
    }
    return s.replace(/@.*$/, "").trim();
  }
}

const orUndef = <T>(v: T, na: T) => (v === na ? undefined : v);
const nonEmpty = (s: string) => (s.length ? s : undefined);

function coord(raw: number, na: number): number | undefined {
  const v = raw / 600_000;
  return raw === na * 600_000 ? undefined : Math.round(v * 1e6) / 1e6;
}

function position(r: BitReader, type: 1 | 2 | 3 | 18): PositionReport | null {
  const classB = type === 18;
  if (!r.has(0, classB ? 139 : 143)) return null;
  const off = classB ? -4 : 0; // class B fields sit 4 bits earlier after sog
  const sogRaw = r.uint(classB ? 46 : 50, 10);
  const lon = coord(r.int(61 + off, 28), 181);
  const lat = coord(r.int(89 + off, 27), 91);
  const cogRaw = r.uint(116 + off, 12);
  const heading = r.uint(128 + off, 9);
  return {
    type,
    mmsi: r.uint(8, 30),
    navStatus: classB ? undefined : orUndef(r.uint(38, 4), 15),
    sog: sogRaw === 1023 ? undefined : sogRaw / 10,
    lon: lon !== undefined && Math.abs(lon) <= 180 ? lon : undefined,
    lat: lat !== undefined && Math.abs(lat) <= 90 ? lat : undefined,
    cog: cogRaw >= 3600 ? undefined : cogRaw / 10,
    heading: orUndef(heading, 511),
    second: r.uint(137 + off, 6),
  };
}

function staticVoyage(r: BitReader): StaticReport | null {
  // Spec length is 424 bits; some transponders send 420. Require everything up to the draught.
  if (!r.has(0, 302)) return null;
  const draught = r.uint(294, 8);
  return {
    type: 5,
    mmsi: r.uint(8, 30),
    imo: orUndef(r.uint(40, 30), 0),
    callsign: nonEmpty(r.text(70, 42)),
    name: nonEmpty(r.text(112, 120)),
    shipType: orUndef(r.uint(232, 8), 0),
    lengthM: orUndef(r.uint(240, 9) + r.uint(249, 9), 0),
    beamM: orUndef(r.uint(258, 6) + r.uint(264, 6), 0),
    draughtM: draught === 0 ? undefined : draught / 10,
    destination: nonEmpty(r.text(302, 120)),
  };
}

function classBStatic(r: BitReader): StaticReport | null {
  if (!r.has(0, 40)) return null;
  const mmsi = r.uint(8, 30);
  const part = r.uint(38, 2);
  if (part === 0) {
    return { type: 24, mmsi, name: nonEmpty(r.text(40, 120)) };
  }
  if (part === 1 && r.has(0, 162)) {
    return {
      type: 24,
      mmsi,
      shipType: orUndef(r.uint(40, 8), 0),
      callsign: nonEmpty(r.text(90, 42)),
      lengthM: orUndef(r.uint(132, 9) + r.uint(141, 9), 0),
      beamM: orUndef(r.uint(150, 6) + r.uint(156, 6), 0),
    };
  }
  return null;
}

export function decodePayload(payload: string, fillBits: number): AisMessage | null {
  let r: BitReader;
  try {
    r = new BitReader(payload, fillBits);
  } catch {
    return null;
  }
  if (!r.has(0, 38)) return null;
  const type = r.uint(0, 6);
  switch (type) {
    case 1:
    case 2:
    case 3:
    case 18:
      return position(r, type);
    case 5:
      return staticVoyage(r);
    case 24:
      return classBStatic(r);
    default:
      return null;
  }
}

export const isPosition = (m: AisMessage): m is PositionReport => m.type !== 5 && m.type !== 24;
