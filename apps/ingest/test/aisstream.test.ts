import { describe, expect, it } from "vitest";
import { toEvents } from "../src/sources/aisstream";

describe("aisstream adapter", () => {
  it("maps a position report inside a region", () => {
    const [e] = toEvents({
      MessageType: "PositionReport",
      MetaData: { MMSI: 235009871, time_utc: "2026-10-22 13:45:12.123456789 +0000 UTC" },
      Message: { PositionReport: { UserID: 235009871, Latitude: 51.03, Longitude: 1.45, Sog: 14.3, Cog: 52.7, TrueHeading: 511, NavigationalStatus: 0 } },
    });
    expect(e).toMatchObject({ kind: "position", region: "dover", data: { mmsi: 235009871, sog: 14.3, heading: undefined, ts: Date.parse("2026-10-22T13:45:12.123Z") } });
  });

  it("drops positions outside every region and malformed messages", () => {
    expect(toEvents({ MessageType: "PositionReport", MetaData: { MMSI: 1 }, Message: { PositionReport: { Latitude: 0, Longitude: 0 } } })).toEqual([]);
    expect(toEvents({ MessageType: "PositionReport" })).toEqual([]);
  });

  it("maps static data", () => {
    const [e] = toEvents({
      MessageType: "ShipStaticData",
      MetaData: { MMSI: 352001234 },
      Message: { ShipStaticData: { Name: "EVER TEST@@@@", Type: 71, ImoNumber: 9811000, MaximumStaticDraught: 14.2, Dimension: { A: 200, B: 133, C: 24, D: 24 }, Destination: "BALBOA" } },
    });
    expect(e).toMatchObject({ kind: "static", data: { name: "EVER TEST", shipType: 71, lengthM: 333, beamM: 48, draughtM: 14.2 } });
  });
});
