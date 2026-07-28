#!/usr/bin/env python3
"""Seed realistic, building-anchored wifi measurements for local testing.

Unlike the bash+curl seed scripts, this reads the real building footprints
from data/facilities.json (so points land inside actual buildings, not a
uniform-random scatter across the whole campus bounding box), and can
backdate timestamps so the heatmap timeline scrubber has a believable
history to show - the public /api/measurements endpoint always stamps
CURRENT_TIMESTAMP, so backfilling requires writing to the DB directly.

Usage:
  python3 test/simulate_campus_wifi.py                       # backfill last 6h (default)
  python3 test/simulate_campus_wifi.py --backfill-hours 24    # backfill last 24h
  python3 test/simulate_campus_wifi.py --clear --backfill-hours 6
  python3 test/simulate_campus_wifi.py --live                 # POST fresh points every 5s until Ctrl-C
  python3 test/simulate_campus_wifi.py --live --interval 10 --base-url http://127.0.0.1:8080
"""
import argparse
import json
import math
import os
import random
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, ".env"))

FACILITIES_PATH = os.path.join(ROOT, "data", "facilities.json")

# Same campus bounds used by frontend/src/measure_page.js, for outdoor sampling.
OUTDOOR_BOUNDS = {"minLat": 35.384, "minLng": 139.424, "maxLat": 35.393, "maxLng": 139.433}
OUTDOOR_POINTS_PER_BUCKET = 3
BUILDING_POINTS_PER_BUCKET = (2, 4)  # inclusive random range
BUCKET_MINUTES = 15  # matches HEATMAP_TIMELINE_BUCKET_MINUTES in map_page.js


def load_buildings():
    """Merge every polygon sub-piece per building into one centroid + bbox."""
    with open(FACILITIES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    coords_by_building = {}
    for item in data:
        if item.get("layer_type") != "polygon":
            continue
        coords = item.get("coords") or []
        if len(coords) < 3:
            continue
        name = item.get("building") or item.get("name")
        coords_by_building.setdefault(name, []).extend(
            (float(c[0]), float(c[1])) for c in coords
        )

    buildings = []
    for name, coords in coords_by_building.items():
        lats = [c[0] for c in coords]
        lngs = [c[1] for c in coords]
        centroid = (sum(lats) / len(lats), sum(lngs) / len(lngs))
        bbox = (min(lats), min(lngs), max(lats), max(lngs))
        buildings.append({"name": name, "centroid": centroid, "bbox": bbox, "quality": building_quality(name)})
    return buildings


def building_quality(name):
    """Deterministic per-building infra quality in [0.55, 0.95], stable across runs."""
    h = 0
    for ch in name:
        h = (h * 31 + ord(ch)) % 9973
    return 0.55 + (h % 100) / 100.0 * 0.4


def congestion_factor(dt):
    """0..1 campus wifi congestion: peaks weekday early afternoon, quiet at night/weekends."""
    hour = dt.hour + dt.minute / 60.0
    peak = math.exp(-((hour - 13.0) ** 2) / (2 * 4.0 ** 2))
    weekday_factor = 1.0 if dt.weekday() < 5 else 0.4
    return peak * weekday_factor


def sample_point_in_building(building, rng):
    min_lat, min_lng, max_lat, max_lng = building["bbox"]
    clat, clng = building["centroid"]
    lat_spread = max((max_lat - min_lat) / 4.0, 1e-6)
    lng_spread = max((max_lng - min_lng) / 4.0, 1e-6)

    lat = min(max(rng.gauss(clat, lat_spread), min_lat), max_lat)
    lng = min(max(rng.gauss(clng, lng_spread), min_lng), max_lng)

    dist_frac = math.hypot((lat - clat) / lat_spread / 4.0, (lng - clng) / lng_spread / 4.0)
    return lat, lng, min(dist_frac, 1.0)


def sample_outdoor_point(rng):
    lat = rng.uniform(OUTDOOR_BOUNDS["minLat"], OUTDOOR_BOUNDS["maxLat"])
    lng = rng.uniform(OUTDOOR_BOUNDS["minLng"], OUTDOOR_BOUNDS["maxLng"])
    return lat, lng


def synth_measurement(quality, dist_frac, congestion, rng, outdoor=False):
    location_factor = 1.0 - 0.35 * dist_frac - (0.3 if outdoor else 0.0)
    location_factor = max(0.15, location_factor)
    base = quality * location_factor
    effective = max(0.05, base - 0.4 * congestion)

    signal_strength = min(5, max(1, round(1 + effective * 4 + rng.uniform(-0.4, 0.4))))
    ping_ms = max(3.0, (1 - effective) * 180 + rng.uniform(-8, 8) + congestion * 40)
    bandwidth = max(2.0, effective * 95 + rng.uniform(-6, 6) - congestion * 20)
    return int(signal_strength), round(ping_ms, 1), round(bandwidth, 1)


def generate_batch(buildings, at_dt, rng):
    """One realistic set of measurements for a single point in time."""
    congestion = congestion_factor(at_dt)
    rows = []

    for building in buildings:
        count = rng.randint(*BUILDING_POINTS_PER_BUCKET)
        for _ in range(count):
            lat, lng, dist_frac = sample_point_in_building(building, rng)
            signal, ping, bandwidth = synth_measurement(building["quality"], dist_frac, congestion, rng)
            rows.append((lat, lng, signal, ping, bandwidth))

    for _ in range(OUTDOOR_POINTS_PER_BUCKET):
        lat, lng = sample_outdoor_point(rng)
        signal, ping, bandwidth = synth_measurement(0.6, 0.0, congestion, rng, outdoor=True)
        rows.append((lat, lng, signal, ping, bandwidth))

    return rows


def backfill(db_name, hours, clear, rng):
    buildings = load_buildings()
    conn = sqlite3.connect(db_name)
    cursor = conn.cursor()

    if clear:
        cursor.execute("DELETE FROM wifi_measurements")
        print(f"Cleared existing wifi_measurements rows.")

    now = datetime.now(timezone.utc)
    bucket_count = max(1, int(hours * 60 / BUCKET_MINUTES))
    inserted = 0

    for i in range(bucket_count, 0, -1):
        bucket_dt = now - timedelta(minutes=i * BUCKET_MINUTES)
        for lat, lng, signal, ping, bandwidth in generate_batch(buildings, bucket_dt, rng):
            cursor.execute(
                """
                INSERT INTO wifi_measurements (timestamp, signal_strength, ping_ms, bandwidth, coords)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    bucket_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    signal,
                    ping,
                    bandwidth,
                    json.dumps([round(lat, 7), round(lng, 7)]),
                ),
            )
            inserted += 1

    conn.commit()
    conn.close()
    print(f"Backfilled {inserted} realistic measurements across {bucket_count} buckets "
          f"({hours}h window, {len(buildings)} buildings) into {db_name}.")


def post_measurement(base_url, lat, lng, signal, ping, bandwidth):
    payload = json.dumps({
        "coords": [round(lat, 7), round(lng, 7)],
        "signal_strength": signal,
        "ping_ms": ping,
        "bandwidth": bandwidth,
    }).encode("utf-8")

    req = urllib.request.Request(
        url=f"{base_url.rstrip('/')}/api/measurements",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status
    except urllib.error.URLError as e:
        print(f"POST failed: {e}", file=sys.stderr)
        return None


def live_loop(base_url, interval, rng):
    buildings = load_buildings()
    print(f"Live mode: POSTing realistic measurements to {base_url} every {interval}s. Ctrl-C to stop.")
    try:
        while True:
            now = datetime.now(timezone.utc)
            batch = generate_batch(buildings, now, rng)
            sample = rng.sample(batch, k=min(len(batch), rng.randint(2, 5)))
            for lat, lng, signal, ping, bandwidth in sample:
                post_measurement(base_url, lat, lng, signal, ping, bandwidth)
            print(f"[{now.strftime('%H:%M:%S')}] posted {len(sample)} measurements")
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nStopped.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backfill-hours", type=float, default=6, help="Hours of history to backfill (default: 6)")
    parser.add_argument("--clear", action="store_true", help="Delete existing wifi_measurements rows first")
    parser.add_argument("--live", action="store_true", help="POST fresh measurements through the API on an interval instead of backfilling")
    parser.add_argument("--interval", type=float, default=5.0, help="Seconds between live posts (default: 5)")
    parser.add_argument("--base-url", default="http://127.0.0.1:8080", help="API base URL for --live mode")
    parser.add_argument("--db", default=None, help="SQLite DB path override (default: DB_NAME from .env)")
    parser.add_argument("--seed", type=int, default=None, help="Random seed for reproducible point scatter")
    args = parser.parse_args()

    rng = random.Random(args.seed)

    if args.live:
        live_loop(args.base_url, args.interval, rng)
        return

    db_name = args.db or os.getenv("DB_NAME")
    if not db_name:
        print("DB_NAME not set in .env and --db not provided.", file=sys.stderr)
        sys.exit(1)

    backfill(db_name, args.backfill_hours, args.clear, rng)


if __name__ == "__main__":
    main()
