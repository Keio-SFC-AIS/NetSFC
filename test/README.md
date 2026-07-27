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

## 3) WebSocket test (no websocat required)

Open in browser:
- test/ws_live_test.html

Steps:
1. Click Connect WS
2. Click POST Test Measurement
3. Confirm NEW_MEASUREMENT appears in the log

