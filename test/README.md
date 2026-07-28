# Test Scripts (isolated)

These files are isolated in this folder to avoid polluting the main project code.

## 1) API smoke test

Run:

```bash
bash test/heatmap_api_smoke.sh http://127.0.0.1:8080
```

What it checks:
- health endpoint
- submit one measurement
- heatmap count
- timeline endpoint basic output

## 2) Seed test measurements

Run:

```bash
bash test/seed_measurements.sh http://127.0.0.1:8080 8
```

This inserts N synthetic points for quick validation.

## 2.1) Seed fake SFC heatmap points (off-campus demo)

Run:

```bash
bash test/seed_fake_heatmap.sh http://127.0.0.1:8080 20
```

This injects randomized measurements inside SFC bounds so the map heat layer can be tested even when you are physically outside campus.

## 2.2) Realistic building-anchored simulation (recommended for real testing)

Run:

```bash
python3 test/simulate_campus_wifi.py --clear --backfill-hours 6
```

Unlike the scripts above, this reads the real building footprints from
`data/facilities.json` and writes directly to SQLite, so points land inside
actual buildings (not a uniform-random scatter) and timestamps can be
backdated across the window - the `/api/measurements` endpoint always stamps
`CURRENT_TIMESTAMP`, so backfilling history requires writing to the DB
directly. Each building gets a stable, deterministic "infra quality" tier and
points degrade with distance from the building centroid and outdoors; a
diurnal congestion curve makes bandwidth/ping worse during weekday
9:00-18:00 and better at night, so the heatmap timeline scrubber shows a
believable pattern instead of flat noise.

Flags:
- `--backfill-hours N` (default 6): how much history to generate
- `--clear`: wipe existing `wifi_measurements` rows first
- `--live [--interval SECONDS]`: instead of backfilling, POST fresh
  measurements through the real API on a loop (Ctrl-C to stop) - use this to
  also exercise the WebSocket live-update path
- `--db PATH`: override the SQLite file (defaults to `DB_NAME` from `.env`)
- `--seed N`: reproducible point scatter

## 3) WebSocket test (no websocat required)

Open in browser:
- test/ws_live_test.html

Steps:
1. Click Connect WS
2. Click POST Test Measurement
3. Confirm NEW_MEASUREMENT appears in the log

