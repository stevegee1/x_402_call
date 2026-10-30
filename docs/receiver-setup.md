# Own AIS receiver: setup

Our own receivers are the licence-free data source for Dover (implementation.md §2.2). Each site streams raw NMEA to the ingest service over WireGuard.

## Bill of materials (per site, about £300–800)

| Item | Example | Notes |
|---|---|---|
| SDR | RTL-SDR Blog V4, or a dAISy HAT, or a dedicated AIS receiver | The dAISy and dedicated receivers decode on-board |
| Antenna | Marine VHF/AIS antenna tuned to 162 MHz | **Height is range**: 10 m up gives about 20–40 nm |
| Cable | Low-loss coax (LMR-400 for runs over 5 m) + lightning arrestor | |
| Computer | Raspberry Pi 4/5 + SD card + PoE or a 5V supply | |
| Enclosure | IP65 box | |

Sites to target (Dover): South Foreland, Dover/Folkestone high ground, Dungeness. Partner with a French-side host near Cap Gris-Nez if possible. Use **at least 2 overlapping sites**; ingest dedupes overlapping reports.

## Software

1. Install [AIS-catcher](https://github.com/jvde-github/AIS-catcher) on the Pi.
2. Join the site to our WireGuard network; the ingest host is `10.66.0.1`.
3. Run:
   ```bash
   AIS-catcher -d:0 -u 10.66.0.1 10110 -M DT
   ```
   - `-u` sends NMEA over UDP to ingest.
   - `-M DT` adds NMEA 4.0 tag blocks, which our parser strips.
4. Add the site to the ingest config: `INGEST_SOURCES=udp`, with a distinct `RECEIVER_ID` per site. For multiple sites on one port, see the TODO below.
5. Check `http://<ingest>:8090/`. `udp:10110.decoded` should increase, and `region_last_event_age_s.dover` should stay below 30.

TODO(M2): a per-site receiver ID taken from the WireGuard peer address, so outage alerts are per antenna.

## Legal

Get a short UK legal confirmation (Wireless Telegraphy Act 2006) on receiving AIS and redistributing derived data before selling it. Do the same check under local law for any non-UK host. See implementation.md §8.5.

## Regenerating decoder test vectors

```bash
python3 -m venv /tmp/v && /tmp/v/bin/pip install pyais
# Decode each sentence with pyais.decode(...).asdict() and update packages/ais/test/decode.test.ts
```
