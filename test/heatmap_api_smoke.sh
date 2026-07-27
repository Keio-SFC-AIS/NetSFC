#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8080}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Please install jq first."
  exit 1
fi

echo "[1/5] Health check"
curl -s "${BASE_URL}/api/health" | jq

echo "[2/5] Submit one measurement"
PAYLOAD='{"coords":[35.3883,139.4283],"signal_strength":5,"ping_ms":12.5,"bandwidth":85.0}'
curl -s -X POST "${BASE_URL}/api/measurements" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}" | jq

echo "[3/5] Heatmap default window count"
curl -s "${BASE_URL}/api/measurements/heatmap" | jq 'length'

echo "[4/5] Heatmap lookback 2 hours count"
curl -s "${BASE_URL}/api/measurements/heatmap?lookback_hours=2&limit=10000" | jq 'length'

echo "[5/5] Timeline check (last 2 hours, 10-min buckets)"
START=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s "${BASE_URL}/api/measurements/heatmap/timeline?start_ts=${START}&end_ts=${END}&bucket_minutes=10&max_frames=100" \
  | jq '.meta, (.frames[] | select((.points|length)>0) | {frame_start_ts, points_count:(.points|length)})'

echo "Done."
