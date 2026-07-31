# Database Schema

SQLite, single file (path from the `DB_NAME` env var). Tables are created on every
app startup by `init_db()` in `init_db.py` (`CREATE TABLE IF NOT EXISTS`, plus
`ensure_column()` which adds any missing columns via `ALTER TABLE` for lightweight
forward migration). There is no separate migrations folder/tool.

## 1. Wi-Fi Measurements (`wifi_measurements`)
Stores crowdsourced Wi-Fi speed/latency samples submitted by clients via
`POST /api/measurements`. Each row is one sample at one point in time; the heatmap
and the AI advisor's `recommend_wifi_spot` tool both read straight from this table.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | INTEGER | Primary Key, Autoincrement | Unique measurement ID |
| `timestamp` | DATETIME | DEFAULT CURRENT_TIMESTAMP | Server-assigned submission time (UTC, `YYYY-MM-DD HH:MM:SS`) |
| `signal_strength` | INTEGER | NOT NULL | Self-reported signal strength, 1-5 |
| `ping_ms` | REAL | NOT NULL | Round-trip latency in milliseconds |
| `bandwidth` | REAL | DEFAULT 0.0 | Measured throughput in Mbps. Optional on submission; defaults to `0.0` if omitted |
| `coords` | TEXT | NOT NULL | JSON array `[lat, lng]` for the point the sample was taken at |

Notes:
- There is no foreign key linking a measurement to a `campus_pois` row - `coords` is
  a free-floating lat/lng, not a POI reference.
- `bandwidth` is measured client-side (the upload duration of a padded request body)
  and submitted as a **second** `POST /api/measurements` call after the latency
  probe, since the server has no way to infer client-side throughput from a single
  request - see `frontend/src/speedtest.js`. Don't be surprised to see two rows very
  close in time per test run.
- Old rows are only removed on demand via `POST /api/measurements/cleanup`
  (`retention_hours`, default 90 days) - there's no automatic/scheduled cleanup job.
- A derived "heat weight" (0-1, higher = better connection) is computed on read from
  `signal_strength`/`ping_ms`/`bandwidth` by `calculate_heat_weight()` in `main.py`;
  it is not stored as a column.

---

## 2. Campus Facilities & Buildings (`campus_pois`)
Stores every element rendered on the map - building outlines, classrooms, and point
facilities (vending machines, washrooms, printers, etc.) - in one table, seeded from
`data/facilities.json` on every startup (`init_db()` upserts each entry with
`INSERT OR REPLACE`, keyed by the JSON's own `id`; when `RUNTIME=DEBUG` the table is
wiped and fully reloaded from the JSON file first).

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | INTEGER | Primary Key | POI/building ID, taken directly from `data/facilities.json` |
| `layer_type` | TEXT | NOT NULL | Element type - see enum below |
| `name` | TEXT | NOT NULL | Display name (e.g. `'Epsilon Building 2'`, `'K11'`) |
| `alias` | TEXT | Nullable | Short label, e.g. a building's single-glyph map label (`'κ'`) or a classroom shorthand |
| `building` | TEXT | Nullable | Owning building name (e.g. `'Alpha Building'`) |
| `floor` | TEXT | Nullable | Floor label(s), e.g. `'1F'`, `'B1F'`, or `'1F, 2F'` for a building spanning floors |
| `coords` | TEXT | NOT NULL, DEFAULT `"[]"` | JSON: a single point `[lat, lng]` for facilities/classrooms, or a closed-ring polygon `[[lat, lng], ...]` for `layer_type='polygon'` buildings |
| `floor_images` | TEXT | DEFAULT `"{}"` | JSON object mapping a floor label to an image path/URL, e.g. `{"1F": "/data/images/kappa_1_1f.png"}` |
| `details` | TEXT | DEFAULT `"{}"` | JSON object of free-form extra data - see below |

### `layer_type` values in use

| Value | Meaning |
| :--- | :--- |
| `polygon` | A building outline (multi-point closed ring in `coords`) |
| `classroom` | A specific classroom (point) |
| `washroom` / `accessible_washroom` | Restroom / accessible restroom |
| `water_fountain` | Drinking water fountain |
| `printer` | Printer |
| `restaurants` | Restaurant / cafeteria / food vendor |
| `elevator` | Elevator |
| `vending_machine` | Vending machine |
| `garbage` | Garbage/trash bin |
| `aed` | AED (defibrillator) |
| `statue` | Landmark statue (always rendered regardless of zoom) |

This list is driven by what's actually present in `data/facilities.json` and used
across `main.py`/`frontend/src/map_page.js` (icon maps, AI-tool synonym table,
always-visible-type list); it is not a DB-level `CHECK` constraint, so nothing stops
a new value from being added by just adding it to the JSON.

### `details` shape (varies by `layer_type`)

`details` is an unstructured JSON blob; the two shapes actually read by the backend:

- **`classroom`** rows (read by the `get_classroom_details` AI tool):
  ```json
  {
    "capacity": 60,
    "equipment": ["projector", "whiteboard"],
    "podium_type": "standing",
    "desk_type": "fixed rows",
    "description": "...",
    "notes": "..."
  }
  ```
- **facility/point** rows (read by the frontend's item detail panel):
  ```json
  {
    "description": "...",
    "notes": "...",
    "images": [{"url": "/data/images/...", "label": "..."}]
  }
  ```

### Building shorthand aliases

For classrooms, `main.py`'s `_load_classroom_prefix_aliases()` derives a
name-prefix -> shorthand table **at query time** from whatever classroom names
already exist in the table (e.g. any `"Kappa <n>"` row implies `"kappa"` and `"k"`
both resolve to the `"Kappa"` prefix) - there is no separate alias table in the
schema for this, and no hardcoded prefix list to keep in sync when new buildings are
added to `data/facilities.json`.

---

## Static assets referenced by this data

`floor_images` values and `details.images[].url` are paths like
`/data/images/...`; the backend serves that directory as static files
(`app.mount("/data/images", StaticFiles(directory="data/images"), ...)` in
`main.py`, only if the directory exists). Frontend code prefixes relative paths
with the configured API host before requesting them.
