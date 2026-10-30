/**
 * NMEA 0183 AIVDM/AIVDO sentence handling: checksum, field parsing and
 * multi-sentence reassembly (e.g. type 5 static data spans two sentences).
 */

export interface AisSentence {
  talker: string; // "AIVDM" | "AIVDO" | "BSVDM" ...
  fragmentCount: number;
  fragmentNumber: number;
  sequentialId: string;
  channel: string;
  payload: string;
  fillBits: number;
}

export function nmeaChecksumValid(sentence: string): boolean {
  const star = sentence.lastIndexOf("*");
  if (star < 1) return false;
  const expected = sentence.slice(star + 1, star + 3).toUpperCase();
  let sum = 0;
  for (let i = 1; i < star; i++) sum ^= sentence.charCodeAt(i);
  return sum.toString(16).toUpperCase().padStart(2, "0") === expected;
}

/** Parses one line. Strips an optional NMEA 4.0 tag block (`\...\`). Returns null for anything invalid. */
export function parseSentence(rawLine: string): AisSentence | null {
  let line = rawLine.trim();
  if (line.startsWith("\\")) {
    const end = line.indexOf("\\", 1);
    if (end < 0) return null;
    line = line.slice(end + 1);
  }
  if (!(line.startsWith("!") || line.startsWith("$"))) return null;
  if (!nmeaChecksumValid(line)) return null;

  const body = line.slice(1, line.lastIndexOf("*"));
  const f = body.split(",");
  if (f.length < 7 || !f[0]!.endsWith("VDM") && !f[0]!.endsWith("VDO")) return null;

  const fragmentCount = Number(f[1]);
  const fragmentNumber = Number(f[2]);
  const fillBits = Number(f[6]);
  if (!Number.isInteger(fragmentCount) || !Number.isInteger(fragmentNumber) || !Number.isInteger(fillBits)) return null;
  if (fragmentCount < 1 || fragmentNumber < 1 || fragmentNumber > fragmentCount || fillBits < 0 || fillBits > 5) return null;

  return {
    talker: f[0]!,
    fragmentCount,
    fragmentNumber,
    sequentialId: f[3] ?? "",
    channel: f[4] ?? "",
    payload: f[5] ?? "",
    fillBits,
  };
}

interface Pending {
  parts: string[];
  received: number;
  firstSeenAt: number;
}

/**
 * Reassembles multi-fragment messages. Fragments are keyed by sequential id + channel
 * and dropped if incomplete after `timeoutMs`.
 */
export class FragmentAssembler {
  private pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 2_000) {}

  push(s: AisSentence, now = Date.now()): { payload: string; fillBits: number } | null {
    if (s.fragmentCount === 1) return { payload: s.payload, fillBits: s.fillBits };

    this.evict(now);
    const key = `${s.sequentialId}|${s.channel}|${s.fragmentCount}`;
    let p = this.pending.get(key);
    if (!p || s.fragmentNumber === 1) {
      p = { parts: new Array(s.fragmentCount).fill(""), received: 0, firstSeenAt: now };
      this.pending.set(key, p);
    }
    if (p.parts[s.fragmentNumber - 1] === "") p.received++;
    p.parts[s.fragmentNumber - 1] = s.payload;

    if (p.received < s.fragmentCount) return null;
    this.pending.delete(key);
    // Fill bits are only meaningful on the final fragment.
    return { payload: p.parts.join(""), fillBits: s.fillBits };
  }

  private evict(now: number) {
    for (const [k, p] of this.pending) if (now - p.firstSeenAt > this.timeoutMs) this.pending.delete(k);
  }
}
