#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8080}"
COUNT="${2:-5}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Please install jq first."
  exit 1
fi

for i in $(seq 1 "${COUNT}"); do
  LAT=$(awk -v n="$i" 'BEGIN{printf "%.7f", 35.3882 + (n * 0.00003)}')
  LNG=$(awk -v n="$i" 'BEGIN{printf "%.7f", 139.4281 + (n * 0.00002)}')
  SIGNAL=$(( (i % 5) + 1 ))
  PING=$(( 10 + i * 6 ))
  BANDWIDTH=$(( 20 + i * 8 ))

  PAYLOAD=$(printf '{"coords":[%s,%s],"signal_strength":%d,"ping_ms":%d,"bandwidth":%d}' "$LAT" "$LNG" "$SIGNAL" "$PING" "$BANDWIDTH")
  curl -s -X POST "${BASE_URL}/api/measurements" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" | jq '.status'
done

echo "Inserted ${COUNT} test measurements."
