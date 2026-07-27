#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8080}"
COUNT="${2:-20}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Please install jq first."
  exit 1
fi

echo "Seeding ${COUNT} fake SFC heatmap points to ${BASE_URL} ..."

for i in $(seq 1 "${COUNT}"); do
  lat=$(awk -v r="$RANDOM" 'BEGIN{printf "%.7f", 35.384 + (r/32767)*(35.393-35.384)}')
  lng=$(awk -v r="$RANDOM" 'BEGIN{printf "%.7f", 139.424 + (r/32767)*(139.433-139.424)}')

  signal=$(( (RANDOM % 5) + 1 ))
  ping=$(awk -v r="$RANDOM" 'BEGIN{printf "%.2f", 8 + (r % 180)}')
  bandwidth=$(awk -v r="$RANDOM" 'BEGIN{printf "%.2f", 8 + (r % 120)}')

  payload=$(printf '{"coords":[%s,%s],"signal_strength":%d,"ping_ms":%s,"bandwidth":%s}' "$lat" "$lng" "$signal" "$ping" "$bandwidth")

  curl -sS -X POST "${BASE_URL}/api/measurements" \
    -H "Content-Type: application/json" \
    -d "$payload" | jq -r '.status // .detail // "unknown"' >/dev/null

done

echo "Done. Injected ${COUNT} fake points around SFC bounds."
