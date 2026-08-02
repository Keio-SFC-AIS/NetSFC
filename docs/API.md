# API Specifications

Base URL is whatever `HOST:PORT` the server is running on (see `.env` / `run.sh`);
locally this is `http://localhost:8080`. All endpoints are defined in `main.py`.
See `docs/DATABASE.md` for the underlying table shapes.

## Health Check
- URL: `/api/health`
- Method: `GET`
- Response:
```json
{"status": "ok", "message": "NetSFC Server is running"}
```

---

## WiFi measurement report
- URL: `/api/measurements`
- Method: `POST`
- Payload (JSON) - field names must match exactly (note it's `signal_strength`, not `signal`):
```json
{
  "signal_strength": 4,
  "ping_ms": 12.5,
  "bandwidth": 100.0,
  "coords": [35.3881, 139.4272]
}
```
| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `signal_strength` | int | yes | 1-5 |
| `ping_ms` | float | yes | milliseconds |
| `bandwidth` | float | no | Mbps, defaults to `0.0` if omitted |
| `coords` | `[lat, lng]` | yes | exactly 2 numbers |

- Response: `201 Created`
```json
{"status": "success", "message": "Measurement recorded and broadcasted"}
```
- Side effect: the row is written to `wifi_measurements`, and a `NEW_MEASUREMENT`
  message is immediately broadcast to every client connected to `/ws/heatmap` (see
  below) - the frontend submits latency and bandwidth as two separate calls to this
  endpoint (`frontend/src/speedtest.js`), so one "network test" typically produces
  two rows / two broadcasts.
- Errors: `422` on schema validation failure (e.g. `signal_strength` out of 1-5,
  `coords` not length 2); `500` on a database error.

---

## Get Heatmap Snapshot
- URL: `/api/measurements/heatmap`
- Method: `GET`
- Query params:

| Param | Type | Default | Notes |
| :--- | :--- | :--- | :--- |
| `start_ts` | ISO-8601 string | - | Inclusive range start. Omit to derive from `lookback_hours` |
| `end_ts` | ISO-8601 string | - | Inclusive range end. Omit to derive from `lookback_hours` |
| `lookback_hours` | int | `168` | Used whenever `start_ts`/`end_ts` isn't enough to pin down both ends (1-2160) |
| `limit` | int | `10000` | Max rows returned (1-100000) |

  Range resolution: if neither timestamp is given, the range is the last
  `lookback_hours` up to now; if both are given, that exact range is used; if only
  `start_ts` is given, the range runs from it to now; if only `end_ts` is given, the
  range is `lookback_hours` ending at it. `start_ts` must not be after `end_ts`
  (`400` otherwise).

  The frontend's "live" heatmap layer calls this with an explicit
  `start_ts`/`end_ts` covering roughly the last 45 minutes and re-polls on an
  interval, rather than relying on the (much larger) `lookback_hours` default - see
  the heatmap section of `report.md` for why.

- Response (JSON array, ordered by timestamp ascending):
```json
[
  {
    "coords": [35.3881, 139.4272],
    "weight": 0.82,
    "signal_strength": 4,
    "ping_ms": 12.5,
    "bandwidth": 55.0
  }
]
```
  `weight` (0-1) is computed on the fly by `calculate_heat_weight()` from the other
  three fields - it is not a stored column.
- Errors: `400` invalid timestamp format or `start_ts > end_ts`; `500` DB error.

---

## Get Heatmap Timeline (bucketed history for playback)
- URL: `/api/measurements/heatmap/timeline`
- Method: `GET`
- Query params:

| Param | Type | Default | Notes |
| :--- | :--- | :--- | :--- |
| `start_ts` | ISO-8601 string | **required** | |
| `end_ts` | ISO-8601 string | **required** | |
| `bucket_minutes` | int | `10` | Frame width (1-120). The frontend's timeline player requests `15` |
| `max_frames` | int | `288` | Upper bound on frame count (1-2000); request rejected if the range/bucket size would exceed it |
| `limit` | int | `200000` | Max raw rows scanned (1-500000) |

- Response (JSON):
```json
{
  "meta": {
    "start_ts": "2026-07-30T12:00:00Z",
    "end_ts": "2026-07-30T18:00:00Z",
    "bucket_minutes": 15,
    "total_frames": 25
  },
  "frames": [
    {
      "frame_start_ts": "2026-07-30T12:00:00Z",
      "frame_end_ts": "2026-07-30T12:14:59Z",
      "points": [
        {"coords": [35.3881, 139.4272], "weight": 0.82, "signal_strength": 4, "ping_ms": 12.5, "bandwidth": 55.0}
      ]
    }
  ]
}
```
  Frames are contiguous and always cover the full requested range (bucket-aligned),
  including empty frames (`points: []`) where no measurements fell in that window.
- Errors: `400` invalid timestamps, `start_ts > end_ts`, or the range would produce
  more than `max_frames` frames; `500` DB error.

---

## Cleanup Old Measurements
- URL: `/api/measurements/cleanup`
- Method: `POST`
- Query params: `retention_hours` (int, default `2160` = 90 days, range 24-8760)
- Deletes every `wifi_measurements` row older than `retention_hours`. Not scheduled
  automatically - call this yourself (e.g. via `test/` scripts or a cron job) if
  retention matters for your deployment.
- Response:
```json
{"status": "success", "deleted_rows": 42, "retention_hours": 2160}
```
- Errors: `500` DB error.

---

## Get All POIs
- URL: `/api/pois`
- Method: `GET`
- Returns every row in `campus_pois` (buildings, classrooms, and point facilities together).
- Response (JSON):
```json
[
  {
    "id": 1,
    "name": "Kappa Building 1",
    "alias": "κ",
    "layer_type": "polygon",
    "building": "Kappa Building",
    "floor": "1F, 2F",
    "coords": [[35.3877722, 139.4263857], [35.3875775, 139.4263387]],
    "floor_images": {"1F": "/data/images/kappa_1_1f.png"},
    "details": {}
  },
  {
    "id": 42,
    "name": "Delta Building 1F Water Dispenser",
    "alias": null,
    "layer_type": "water_fountain",
    "building": "Delta Building",
    "floor": "1F",
    "coords": [35.3881, 139.4272],
    "floor_images": {},
    "details": {}
  }
]
```
  `coords` is `[lat, lng]` for point facilities/classrooms, or a list of `[lat, lng]`
  pairs (closed ring) for `layer_type: "polygon"` buildings.
- Errors: `500` DB error.

---

## Get Items by Layer Type
- URL: `/api/layers/{layerType}` (e.g. `/api/layers/water_fountain`, `/api/layers/classroom`)
- Method: `GET`
- `layerType` is matched **exactly** against the `layer_type` column (no synonym
  normalization like the AI advisor's tools do) - see the enum table in
  `docs/DATABASE.md` for valid values. An unrecognized value just returns `[]`.
- Response (JSON) - same shape as `/api/pois` entries **except `details` is not
  included**:
```json
[
  {
    "id": 42,
    "name": "Delta Building 1F Water Dispenser",
    "alias": null,
    "layer_type": "water_fountain",
    "building": "Delta Building",
    "floor": "1F",
    "coords": [35.3881, 139.4272],
    "floor_images": {}
  }
]
```
- Errors: `500` DB error.

---

## AI Campus Advisor Chat
- URL: `/api/assistant/chat`
- Method: `POST`
- Payload (JSON):
```json
{
  "question": "where's the nearest vending machine?",
  "user_lat": 35.3881,
  "user_lng": 139.4272
}
```
| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `question` | string | yes | 3-1000 chars |
| `user_lat` / `user_lng` | float | no | Visitor's current position, used by "nearest X" style questions when the question doesn't name a location explicitly |

- Behavior: runs a two-round tool-calling flow (`run_assistant_tools_flow()`)
  against four local tools that query `campus_pois`/`wifi_measurements` directly -
  the model never invents coordinates/equipment lists itself. The LLM backing this
  flow is provider-agnostic (`ai_providers.py`) - OpenAI, Grok (xAI), Gemini, and
  Claude are all supported and selected via the `AI_PROVIDER` env var (see README).
- Response (JSON):
```json
{
  "answer": "The nearest vending machine is on the 1F of Kappa Building, about 40m away.",
  "model": "gpt-4o-mini",
  "action": {
    "type": "focus_poi",
    "poi_id": 42,
    "coords": [35.3881, 139.4272],
    "label": "Kappa Building 1F Vending Machine",
    "classroom_name": null,
    "building_name": null
  }
}
```
  `action.type` is one of `focus_poi`, `focus_coords`, `open_classroom`,
  `focus_building`, or `none` - the frontend uses it to drive the map (fly to a
  point, open a building/classroom panel) instead of only showing text.
- Errors: `400` question shorter than 3 chars; `503` no AI provider configured
  (missing API key, or `AI_PROVIDER` unset with no default key) on the server;
  `502` the upstream LLM API call itself failed.

---

## Real-time Heatmap WebSocket
- URL: `/ws/heatmap` (`ws://` / `wss://`)
- Protocol: connect and listen. The server pushes a JSON message to **every**
  connected client whenever anyone calls `POST /api/measurements`:
```json
{
  "type": "NEW_MEASUREMENT",
  "data": {
    "coords": [35.3881, 139.4272],
    "weight": 0.82,
    "signal_strength": 4,
    "ping_ms": 12.5,
    "bandwidth": 55.0
  }
}
```
- The endpoint otherwise just calls `receive_text()` in a loop and discards
  whatever it gets - it doesn't reply to client messages, but the connection stays
  open only as long as the client doesn't close it. The frontend sends a harmless
  `"ping"` text frame every 25s purely to keep the connection alive through
  proxies/load balancers that kill idle sockets; the server does not need it and
  does not respond to it.
- No auth, no per-client filtering - all measurements from all locations are
  broadcast to all connected clients.
