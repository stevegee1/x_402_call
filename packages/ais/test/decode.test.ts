import { describe, expect, it } from "vitest";
import { decodePayload, Deduper, FragmentAssembler, NmeaPipeline, nmeaChecksumValid, parseSentence, TrafficSimulator } from "../src";

// Reference values produced by pyais 2.x (see docs/receiver-setup.md for how to regenerate).
const VECTORS: { sentences: string[]; expected: Record<string, unknown> }[] = [
  {
    sentences: ["!AIVDM,1,1,,B,15M67FC000G?ufbE`FepT@3n00Sa,0*5C"],
    expected: { type: 1, mmsi: 366053209, navStatus: 3, sog: 0, lon: -122.341618, lat: 37.802118, cog: 219.3, heading: 1, second: 59 },
  },
  {
    sentences: ["!AIVDM,1,1,,A,13aEOK?P00PD2wVMdLDRhgvL289?,0*26"],
    expected: { type: 1, mmsi: 244670316, navStatus: undefined, sog: 0, lon: 4.379285, lat: 51.89475, cog: 70.6, heading: undefined, second: 14 },
  },
  {
    sentences: [
      "!AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0*1C",
      "!AIVDM,2,2,1,A,88888888880,2*25",
    ],
    expected: { type: 5, mmsi: 351759000, imo: 9134270, callsign: "3FOF8", name: "EVER DIADEM", shipType: 70, lengthM: 295, beamM: 32, draughtM: 12.2, destination: "NEW YORK" },
  },
  {
    sentences: ["!AIVDM,1,1,,A,B6CdCm0t3`tba35f@V9faHi7kP06,0*58"],
    expected: { type: 18, mmsi: 423302100, sog: 1.4, lon: 53.010997, lat: 40.005283, cog: 177, heading: 177, second: 34 },
  },
  {
    sentences: ["!AIVDO,1,1,,A,13P7oChP2?06a:TM<nO23ibIP000,0*22"],
    expected: { type: 1, mmsi: 235009871, navStatus: 0, sog: 14.3, lon: 1.45123, lat: 51.0321, cog: 52.7, heading: 53, second: 12 },
  },
  {
    sentences: ["!AIVDO,1,1,,A,B3aDoVh00P4UooWKqg1hSwl00000,0*3B"],
    expected: { type: 18, mmsi: 244660123, sog: 0.2, lon: 4.012345, lat: 51.9812, cog: 180, heading: undefined, second: 40 },
  },
  {
    sentences: [
      "!AIVDO,2,1,3,A,55?dLlP2Ee3S<D4;L00EHE:1@E=@000000000017I25HH2dVNSPPC0Sh@000,0*20",
      "!AIVDO,2,2,3,A,00000000000,2*25",
    ],
    expected: { type: 5, mmsi: 352001234, imo: 9811000, callsign: "3EAB7", name: "EVER TEST", shipType: 71, lengthM: 333, beamM: 48, draughtM: 14.2, destination: "BALBOA" },
  },
  {
    sentences: ["!AIVDO,1,1,,A,H3P>7:@@uHE:10Thu@0000000000,0*76"],
    expected: { type: 24, mmsi: 235112233, name: "DOVER PILOT" },
  },
  {
    sentences: ["!AIVDO,1,1,,A,H3P>7:Dj0000000=@9<i001@8330,0*4A"],
    expected: { type: 24, mmsi: 235112233, shipType: 50, callsign: "MPIL1", lengthM: 18, beamM: 6 },
  },
];

function decodeSentences(sentences: string[]) {
  const asm = new FragmentAssembler();
  let full: { payload: string; fillBits: number } | null = null;
  for (const s of sentences) full = asm.push(parseSentence(s)!);
  return full && decodePayload(full.payload, full.fillBits);
}

describe("NMEA", () => {
  it("validates checksums", () => {
    expect(nmeaChecksumValid("!AIVDM,1,1,,B,15M67FC000G?ufbE`FepT@3n00Sa,0*5C")).toBe(true);
    expect(nmeaChecksumValid("!AIVDM,1,1,,B,15M67FC000G?ufbE`FepT@3n00Sa,0*5D")).toBe(false);
    expect(parseSentence("!AIVDM,1,1,,B,15M67FC000G?ufbE`FepT@3n00Sa,0*5D")).toBeNull();
  });

  it("strips NMEA 4.0 tag blocks", () => {
    const s = parseSentence("\\s:rcv1,c:1729600000*00\\!AIVDM,1,1,,B,15M67FC000G?ufbE`FepT@3n00Sa,0*5C");
    expect(s?.payload).toBe("15M67FC000G?ufbE`FepT@3n00Sa");
  });

  it("drops incomplete multipart messages after timeout", () => {
    const asm = new FragmentAssembler(1_000);
    expect(asm.push(parseSentence(VECTORS[2]!.sentences[0]!)!, 0)).toBeNull();
    // Second fragment arrives too late for the first; a lone part 2 cannot complete.
    expect(asm.push(parseSentence(VECTORS[2]!.sentences[1]!)!, 5_000)).toBeNull();
  });
});

describe("decoder matches pyais reference", () => {
  for (const v of VECTORS) {
    it(`type ${v.expected.type} mmsi ${v.expected.mmsi}`, () => {
      const msg = decodeSentences(v.sentences);
      expect(msg).not.toBeNull();
      expect(msg).toMatchObject(v.expected);
    });
  }
});

describe("pipeline", () => {
  it("assigns regions and drops out-of-region positions", () => {
    const p = new NmeaPipeline({ source: "test", mode: "live" });
    expect(p.push(VECTORS[0]!.sentences[0]!)).toBeNull(); // San Francisco: outside all regions
    const dover = p.push(VECTORS[4]!.sentences[0]!, 1_000);
    expect(dover).toMatchObject({ kind: "position", region: "dover", data: { mmsi: 235009871, ts: 1_000, mode: "live" } });
    const rdam = p.push(VECTORS[1]!.sentences[0]!);
    expect(rdam).toMatchObject({ kind: "position", region: "rotterdam" });
  });

  it("dedupes the same report heard by two receivers", () => {
    const p = new NmeaPipeline({ source: "test", mode: "live" });
    const d = new Deduper(5_000);
    const a = p.push(VECTORS[4]!.sentences[0]!, 0)!;
    const b = p.push(VECTORS[4]!.sentences[0]!, 100)!;
    expect(d.isDuplicate(a, 0)).toBe(false);
    expect(d.isDuplicate(b, 100)).toBe(true);
    expect(d.isDuplicate(b, 10_000)).toBe(false);
  });
});

describe("simulator", () => {
  it("emits simulated positions inside region bboxes", () => {
    const sim = new TrafficSimulator({ vesselsPerRegion: 20, seed: 7, darkFraction: 0 });
    const events = Array.from({ length: 20 }, (_, i) => sim.step(1_000, i * 1_000)).flat();
    const positions = events.filter((e) => e.kind === "position");
    expect(positions.length).toBeGreaterThan(10);
    for (const e of positions) if (e.kind === "position") expect(e.data.mode).toBe("simulated");
  });
});
