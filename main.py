from fastapi import FastAPI, HTTPException, Query, status, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import sqlite3, os, asyncio, json, math, re, difflib
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Coroutine, cast
from dotenv import load_dotenv
from loguru import logger
from init_db import init_db

load_dotenv()
APITITLE:str | None = os.getenv("APITITLE")
VERSION:str | None = os.getenv("VERSION")
DB_NAME:str | None = os.getenv("DB_NAME")
RUNTIME:str | None = os.getenv("RUNTIME")
CHATGPT_API_KEY:str | None = os.getenv("CHATGPT_API_KEY") or os.getenv("OPENAI_API_KEY")
CHATGPT_MODEL:str = os.getenv("CHATGPT_MODEL", "gpt-4o-mini")
raw_origins = os.getenv("CORS_ORIGINS", "")
origins = [origin.strip() for origin in raw_origins.split(",") if origin.strip()]

if not APITITLE or not VERSION or not DB_NAME:
    logger.error("Configuration Error")
    raise ValueError("Configuration Value is empty, check your .env")

app = FastAPI(title=APITITLE, version=VERSION)
init_db(DB_NAME)

if os.path.exists("data/images"):
    app.mount("/data/images", StaticFiles(directory="data/images"), name="data_images")

if not origins or RUNTIME == "DEBUG":
    origins = ["*"]

ORIGINS = origins

app.add_middleware(
    CORSMiddleware,
    allow_origins = ORIGINS,
    allow_credentials = True,
    allow_methods = ["*"],
    allow_headers = ["*"],
)

class MeasurementReport(BaseModel):
    coords: list[float] = Field(..., description="[latitude, longitude]", min_length=2, max_length=2)
    signal_strength: int = Field(..., ge=1, le=5)
    ping_ms: float = Field(...)
    bandwidth: float | None = 0.0

class POIResponse(BaseModel):
    id: int
    name: str
    alias: str | None = None
    layer_type: str
    building: str | None = None
    floor: str | None = None
    coords: list[Any]
    floor_images: dict[str, str] | None = None
    details: dict[str, Any] | None = None

class HeatmapPointResponse(BaseModel):
    coords: list[float]
    weight: float
    signal_strength: int
    ping_ms: float
    bandwidth: float | None = 0.0

class HeatmapCleanupResponse(BaseModel):
    status: str
    deleted_rows: int
    retention_hours: int

class HeatmapTimelineMeta(BaseModel):
    start_ts: str
    end_ts: str
    bucket_minutes: int
    total_frames: int

class HeatmapTimelineFrame(BaseModel):
    frame_start_ts: str
    frame_end_ts: str
    points: List[HeatmapPointResponse]

class HeatmapTimelineResponse(BaseModel):
    meta: HeatmapTimelineMeta
    frames: List[HeatmapTimelineFrame]

class AssistantQueryRequest(BaseModel):
    question: str = Field(..., min_length=3, max_length=1000)
    user_lat: float | None = Field(default=None, description="Visitor's current latitude, used for 'nearest' queries")
    user_lng: float | None = Field(default=None, description="Visitor's current longitude, used for 'nearest' queries")

class AssistantAction(BaseModel):
    type: str = "none"
    poi_id: int | None = None
    coords: list[float] | None = None
    label: str | None = None
    classroom_name: str | None = None

class AssistantQueryResponse(BaseModel):
    answer: str
    model: str
    action: AssistantAction

# Helper Function 
def calculate_heat_weight(signal_strength: int, ping_ms: float, bandwidth: float) -> float:
    signal_score = (signal_strength / 5) * 0.3
    ping_score = max(0.0, 1.0 - (ping_ms / 200)) * 0.3
    bandwidth_score = min(bandwidth / 100, 1.0) * 0.4
    return round(signal_score + ping_score + bandwidth_score, 2)

def parse_iso_datetime_to_utc(value: str, field_name: str) -> datetime:
    raw = value.strip()
    if raw.endswith('Z'):
        raw = raw[:-1] + '+00:00'
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {field_name}. Use ISO-8601 format, e.g. 2026-07-28T09:00:00Z"
        )

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)

def floor_datetime_to_bucket(dt: datetime, bucket_minutes: int) -> datetime:
    bucket_seconds = bucket_minutes * 60
    ts = int(dt.timestamp())
    floored = ts - (ts % bucket_seconds)
    return datetime.fromtimestamp(floored, tz=timezone.utc)

def format_utc_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')

def haversine_distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    earth_radius_m = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * earth_radius_m * math.asin(math.sqrt(a))

POI_TYPE_SYNONYMS: Dict[str, str] = {
    "vending machine": "vending_machine", "vending machines": "vending_machine",
    "vending": "vending_machine", "snack machine": "vending_machine", "drink machine": "vending_machine",
    "restroom": "washroom", "bathroom": "washroom", "toilet": "washroom", "washroom": "washroom",
    "accessible restroom": "accessible_washroom", "accessible washroom": "accessible_washroom",
    "accessible toilet": "accessible_washroom", "wheelchair restroom": "accessible_washroom",
    "water fountain": "water_fountain", "drinking fountain": "water_fountain", "water": "water_fountain",
    "printer": "printer", "printing": "printer",
    "aed": "aed", "defibrillator": "aed",
    "elevator": "elevator", "lift": "elevator",
    "restaurant": "restaurants", "restaurants": "restaurants", "food": "restaurants", "cafeteria": "restaurants",
    "garbage": "garbage", "trash": "garbage", "trash can": "garbage", "bin": "garbage",
    "statue": "statue",
}

def normalize_poi_type(raw: str) -> str | None:
    key = raw.strip().lower()
    if key in POI_TYPE_SYNONYMS:
        return POI_TYPE_SYNONYMS[key]
    key_snake = key.replace(" ", "_")
    if key_snake in set(POI_TYPE_SYNONYMS.values()):
        return key_snake
    return None

def tool_find_nearest_poi(poi_type: str, near_lat: float, near_lng: float, limit: int = 3) -> Dict[str, Any]:
    normalized_type = normalize_poi_type(poi_type)
    if not normalized_type:
        return {"error": f"Unknown POI type '{poi_type}'. Known types: {sorted(set(POI_TYPE_SYNONYMS.values()))}"}
    if not DB_NAME:
        raise ValueError("Database invalid.")

    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute("SELECT id, name, building, floor, coords FROM campus_pois WHERE layer_type = ?", (normalized_type,))
    rows = cursor.fetchall()
    conn.close()

    candidates: List[Dict[str, Any]] = []
    for row in rows:
        coords_raw = json.loads(row[4]) if row[4] else []
        if len(coords_raw) != 2:
            continue
        lat, lng = float(coords_raw[0]), float(coords_raw[1])
        candidates.append({
            "id": row[0], "name": row[1], "building": row[2], "floor": row[3],
            "coords": [lat, lng], "distance_m": round(haversine_distance_m(near_lat, near_lng, lat, lng), 1),
        })

    if not candidates:
        return {"error": f"No '{normalized_type}' facilities found in the campus data."}

    candidates.sort(key=lambda c: c["distance_m"])
    return {"poi_type": normalized_type, "results": candidates[:limit]}

def _load_building_centroids() -> List[Dict[str, Any]]:
    if not DB_NAME:
        raise ValueError("Database invalid.")
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute("SELECT building, coords FROM campus_pois WHERE layer_type = 'polygon'")
    rows = cursor.fetchall()
    conn.close()

    grouped: Dict[str, List[List[float]]] = {}
    for building, coords_raw in rows:
        if not building:
            continue
        coords = json.loads(coords_raw) if coords_raw else []
        grouped.setdefault(building, []).extend(coords)

    centroids: List[Dict[str, Any]] = []
    for building, coords in grouped.items():
        if not coords:
            continue
        lats = [c[0] for c in coords]
        lngs = [c[1] for c in coords]
        centroids.append({"building": building, "lat": sum(lats) / len(lats), "lng": sum(lngs) / len(lngs)})
    return centroids

def _nearest_building_label(lat: float, lng: float, centroids: List[Dict[str, Any]]) -> str | None:
    if not centroids:
        return None
    nearest = min(centroids, key=lambda c: haversine_distance_m(lat, lng, c["lat"], c["lng"]))
    return cast(str, nearest["building"])

def tool_recommend_wifi_spot(min_bandwidth_mbps: float | None = None, max_ping_ms: float | None = None, limit: int = 3) -> Dict[str, Any]:
    if not DB_NAME:
        raise ValueError("Database invalid.")

    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT coords, AVG(signal_strength), AVG(ping_ms), AVG(bandwidth), COUNT(*)
        FROM wifi_measurements
        WHERE timestamp >= datetime('now', '-72 hours')
        GROUP BY coords
        """
    )
    rows = cursor.fetchall()
    conn.close()

    centroids = _load_building_centroids()
    spots: List[Dict[str, Any]] = []
    for row in rows:
        coords_raw = json.loads(row[0]) if row[0] else []
        if len(coords_raw) != 2:
            continue
        lat, lng = float(coords_raw[0]), float(coords_raw[1])
        avg_signal, avg_ping, avg_bandwidth = float(row[1] or 0.0), float(row[2] or 0.0), float(row[3] or 0.0)

        if min_bandwidth_mbps is not None and avg_bandwidth < min_bandwidth_mbps:
            continue
        if max_ping_ms is not None and avg_ping > max_ping_ms:
            continue

        spots.append({
            "coords": [lat, lng],
            "avg_signal_strength": round(avg_signal, 2),
            "avg_ping_ms": round(avg_ping, 2),
            "avg_bandwidth_mbps": round(avg_bandwidth, 2),
            "samples": int(row[4] or 0),
            "weight": calculate_heat_weight(int(round(avg_signal)), avg_ping, avg_bandwidth),
            "near_building": _nearest_building_label(lat, lng, centroids),
        })

    if not spots:
        return {"error": "No wifi measurements match the given thresholds in the last 72 hours."}

    spots.sort(key=lambda s: cast(float, s["weight"]), reverse=True)
    return {"results": spots[:limit]}

def _load_classroom_prefix_aliases() -> Dict[str, str]:
    """Map lowercase full-name / single-letter shorthand -> canonical classroom name prefix,
    built from whatever prefixes actually exist in the data (not hardcoded)."""
    if not DB_NAME:
        raise ValueError("Database invalid.")
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute("SELECT DISTINCT name FROM campus_pois WHERE layer_type = 'classroom'")
    names = [row[0] for row in cursor.fetchall()]
    conn.close()

    prefixes = set()
    for name in names:
        match = re.match(r'^([A-Za-z ]+?)\s*\d*$', name.strip())
        if match and match.group(1).strip():
            prefixes.add(match.group(1).strip())

    alias_map: Dict[str, str] = {}
    for prefix in prefixes:
        alias_map[prefix.lower()] = prefix
        alias_map.setdefault(prefix[0].lower(), prefix)
    return alias_map

def _normalize_classroom_query(query: str, alias_map: Dict[str, str]) -> str | None:
    match = re.match(r'^([A-Za-z]+)\s*-?\s*(\d+)$', query.strip())
    if not match:
        return None
    letters, number = match.group(1).lower(), match.group(2)
    canonical_prefix = alias_map.get(letters)
    return f"{canonical_prefix} {number}" if canonical_prefix else None

def tool_get_classroom_details(query: str) -> Dict[str, Any]:
    if not DB_NAME:
        raise ValueError("Database invalid.")

    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute("SELECT name, building, floor, details FROM campus_pois WHERE layer_type = 'classroom'")
    rows = cursor.fetchall()
    conn.close()

    by_name = {row[0]: row for row in rows}
    raw_query = query.strip()

    lookup_lower = {name.lower(): name for name in by_name}
    matched_name = lookup_lower.get(raw_query.lower())

    if not matched_name:
        normalized = _normalize_classroom_query(raw_query, _load_classroom_prefix_aliases())
        if normalized in by_name:
            matched_name = normalized

    if not matched_name:
        close = difflib.get_close_matches(raw_query, by_name.keys(), n=3, cutoff=0.5)
        if close:
            return {"error": f"No exact match for '{query}'.", "did_you_mean": close}
        return {"error": f"No classroom found matching '{query}'."}

    name, building, floor, details_raw = by_name[matched_name]
    loaded_details: Any = json.loads(details_raw) if details_raw else {}
    details: Dict[str, Any] = cast(Dict[str, Any], loaded_details) if isinstance(loaded_details, dict) else {}
    return {
        "name": name,
        "building": building,
        "floor": floor,
        "capacity": details.get("capacity"),
        "equipment": details.get("equipment", []),
        "podium_type": details.get("podium_type"),
        "desk_type": details.get("desk_type"),
        "description": details.get("description"),
        "notes": details.get("notes"),
    }

ASSISTANT_SYSTEM_PROMPT = (
    "You are the NetSFC AI Advisor for Keio University SFC campus. You help students "
    "find facilities, pick a good wifi spot, and learn about classrooms. Always call one "
    "of the available tools to look up real campus data before answering location, wifi, "
    "or classroom questions - never guess distances, coordinates, or equipment lists. "
    "If a question is unrelated to campus (small talk, etc.), answer briefly without "
    "calling a tool. Keep answers concise and concrete, referencing the real names/numbers "
    "returned by the tools."
)

ASSISTANT_TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "find_nearest_poi",
            "description": (
                "Find the nearest facility of a given type (vending machine, washroom, "
                "water fountain, printer, aed, elevator, restaurant, garbage can, "
                "accessible washroom, statue) to a location on SFC campus."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "poi_type": {"type": "string", "description": "The kind of facility, e.g. 'vending machine', 'restroom', 'water fountain'"},
                    "near_lat": {"type": "number", "description": "Latitude to search near. Omit to use the visitor's current location."},
                    "near_lng": {"type": "number", "description": "Longitude to search near. Omit to use the visitor's current location."},
                },
                "required": ["poi_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recommend_wifi_spot",
            "description": (
                "Recommend the best on-campus spot(s) for a strong, low-latency wifi "
                "connection (e.g. for a Zoom call or a large download), based on real "
                "recent measurements."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "min_bandwidth_mbps": {"type": "number", "description": "Minimum acceptable bandwidth in Mbps, if the user specified one"},
                    "max_ping_ms": {"type": "number", "description": "Maximum acceptable ping in ms, if the user specified one"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_classroom_details",
            "description": (
                "Look up a specific classroom's details (equipment, capacity, layout, "
                "notes) by name or shorthand, e.g. 'K11', 'Kappa 11', 'Omicron 23'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The classroom name or shorthand the user asked about"},
                },
                "required": ["query"],
            },
        },
    },
]

TOOL_IMPLEMENTATIONS = {
    "find_nearest_poi": tool_find_nearest_poi,
    "recommend_wifi_spot": tool_recommend_wifi_spot,
    "get_classroom_details": tool_get_classroom_details,
}

def _openai_chat_request(messages: List[Dict[str, Any]], tools: List[Dict[str, Any]] | None = None) -> Dict[str, Any]:
    if not CHATGPT_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="CHATGPT_API_KEY is not configured. Set it in .env before using /api/assistant/chat"
        )

    payload: Dict[str, Any] = {"model": CHATGPT_MODEL, "temperature": 0.2, "messages": messages}
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    req = urllib.request.Request(
        url="https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {CHATGPT_API_KEY}"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            body = response.read().decode("utf-8")
        parsed: Any = json.loads(body)
        return cast(Dict[str, Any], parsed) if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore") if hasattr(e, "read") else str(e)
        logger.error(f"ChatGPT API HTTP error: {e.code} {detail}")
        raise HTTPException(status_code=502, detail="ChatGPT API call failed")
    except Exception as e:
        logger.error(f"ChatGPT API error: {str(e)}")
        raise HTTPException(status_code=502, detail="ChatGPT API request failed")

def _build_action_from_tool_result(tool_name: str, tool_result: Dict[str, Any]) -> Dict[str, Any]:
    if "error" in tool_result:
        return {"type": "none"}

    if tool_name == "find_nearest_poi":
        results = tool_result.get("results") or []
        if not results:
            return {"type": "none"}
        top = results[0]
        return {"type": "focus_poi", "poi_id": top["id"], "coords": top["coords"], "label": top["name"]}

    if tool_name == "recommend_wifi_spot":
        results = tool_result.get("results") or []
        if not results:
            return {"type": "none"}
        top = results[0]
        label = f"Near {top['near_building']}" if top.get("near_building") else "Recommended spot"
        return {"type": "focus_coords", "coords": top["coords"], "label": label}

    if tool_name == "get_classroom_details":
        if "name" not in tool_result:
            return {"type": "none"}
        return {"type": "open_classroom", "classroom_name": tool_result["name"]}

    return {"type": "none"}

def run_assistant_tools_flow(question: str, user_lat: float | None, user_lng: float | None) -> Dict[str, Any]:
    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": ASSISTANT_SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]

    first = _openai_chat_request(messages, tools=ASSISTANT_TOOLS)
    choices = first.get("choices") or []
    if not choices:
        raise HTTPException(status_code=502, detail="ChatGPT response did not include choices")

    message = choices[0].get("message") or {}
    tool_calls = message.get("tool_calls") or []

    if not tool_calls:
        answer = str(message.get("content") or "").strip()
        return {"answer": answer or "I'm not sure how to help with that.", "action": {"type": "none"}}

    messages.append(message)
    action: Dict[str, Any] = {"type": "none"}

    for tool_call in tool_calls:
        function = tool_call.get("function") or {}
        name = function.get("name")
        try:
            args = json.loads(function.get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}

        implementation = TOOL_IMPLEMENTATIONS.get(name)
        if implementation is None:
            result: Dict[str, Any] = {"error": f"Unknown tool '{name}'"}
        else:
            if name == "find_nearest_poi":
                if args.get("near_lat") is None:
                    args["near_lat"] = user_lat
                if args.get("near_lng") is None:
                    args["near_lng"] = user_lng
                if args.get("near_lat") is None or args.get("near_lng") is None:
                    result = {"error": "No location available to search near."}
                    args = {}
                else:
                    try:
                        result = implementation(**args)
                    except TypeError as e:
                        result = {"error": f"Invalid arguments for '{name}': {e}"}
            else:
                try:
                    result = implementation(**args)
                except TypeError as e:
                    result = {"error": f"Invalid arguments for '{name}': {e}"}

        if action["type"] == "none":
            action = _build_action_from_tool_result(name, result)

        messages.append({
            "role": "tool",
            "tool_call_id": tool_call.get("id"),
            "content": json.dumps(result, ensure_ascii=False),
        })

    second = _openai_chat_request(messages)
    second_choices = second.get("choices") or []
    if not second_choices:
        raise HTTPException(status_code=502, detail="ChatGPT response did not include choices")

    final_message = second_choices[0].get("message") or {}
    answer = str(final_message.get("content") or "").strip()
    return {"answer": answer or "I found some information, but couldn't phrase a response.", "action": action}

class ConnectionManager():
    def __init__(self):
        self.connections:list[WebSocket] = []
    
    async def connect(self, websocket:WebSocket):
        await websocket.accept()
        self.connections.append(websocket)
        logger.info("New connection established")

    def disconnect(self, websocket:WebSocket):
        if websocket in self.connections:
            self.connections.remove(websocket)
            logger.info("Client disconnected")

    async def broadcast_json(self, data: dict[str,Any] | list[Any]):
        if not self.connections:
            return 
        
        tasks:list[Coroutine[Any, Any, None]] = []
        for connection in self.connections:
            tasks.append(self._send_json(connection, data))
        await asyncio.gather(*tasks)

    async def _send_json(self, websocket:WebSocket, data: dict[str,Any] | list[Any]):
        try:
            await websocket.send_json(data)
        except Exception:
            self.disconnect(websocket)

manager = ConnectionManager()

@app.websocket("/ws/heatmap")
async def heatmap_websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"Unexpected WebSocket error: {str(e)}")
        manager.disconnect(websocket)

@app.post("/api/measurements", status_code=status.HTTP_201_CREATED)
async def report_measurement(report: MeasurementReport):
    try:
        # TODO Broadcast to all other devices using WebSocket
        if not DB_NAME:
            logger.error("Invalid Database Name")
            raise ValueError("Database invalid.")
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        bandwidth = report.bandwidth or 0.0
        cursor.execute('''
            INSERT INTO wifi_measurements (signal_strength, ping_ms, bandwidth, coords)
            VALUES (?, ?, ?, ?)
        ''', (report.signal_strength, report.ping_ms, bandwidth, json.dumps(report.coords, ensure_ascii=False)))
        conn.commit()
        conn.close()
        weight = calculate_heat_weight(report.signal_strength, report.ping_ms, bandwidth)
        broadcast:Dict[str, Any] = {
            "type": "NEW_MEASUREMENT",
            "data": {
                "coords": report.coords,
                "weight": weight,
                "signal_strength": report.signal_strength,
                "ping_ms": report.ping_ms,
                "bandwidth": bandwidth
            }
        }
        await manager.broadcast_json(broadcast)
        return {"status": "success", "message": "Measurement recorded and broadcasted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/measurements/heatmap", response_model=List[HeatmapPointResponse])
async def get_heatmap_data(
    start_ts: str | None = Query(default=None, description="Inclusive start timestamp in ISO-8601"),
    end_ts: str | None = Query(default=None, description="Inclusive end timestamp in ISO-8601"),
    lookback_hours: int = Query(default=168, ge=1, le=2160, description="Used when start/end are omitted"),
    limit: int = Query(default=10000, ge=1, le=100000, description="Maximum rows returned")
):
    try:
        if not DB_NAME:
            logger.error("Invalid Database Name")
            raise ValueError("Database invalid.")

        now_utc = datetime.now(timezone.utc)
        if start_ts is None and end_ts is None:
            end_dt = now_utc
            start_dt = now_utc - timedelta(hours=lookback_hours)
        elif start_ts is not None and end_ts is not None:
            start_dt = parse_iso_datetime_to_utc(start_ts, "start_ts")
            end_dt = parse_iso_datetime_to_utc(end_ts, "end_ts")
        elif start_ts is not None:
            start_dt = parse_iso_datetime_to_utc(start_ts, "start_ts")
            end_dt = now_utc
        else:
            if end_ts is None:
                raise HTTPException(status_code=400, detail="end_ts is required when start_ts is omitted in this branch")
            end_dt = parse_iso_datetime_to_utc(end_ts, "end_ts")
            start_dt = end_dt - timedelta(hours=lookback_hours)

        if start_dt > end_dt:
            raise HTTPException(status_code=400, detail="start_ts must be earlier than or equal to end_ts")

        start_sql = start_dt.strftime("%Y-%m-%d %H:%M:%S")
        end_sql = end_dt.strftime("%Y-%m-%d %H:%M:%S")

        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT coords, signal_strength, ping_ms, bandwidth
            FROM wifi_measurements
            WHERE timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
            LIMIT ?
        """, (start_sql, end_sql, limit))
        rows = cursor.fetchall()
        conn.close()

        results: List[Dict[str, Any]] = []
        for row in rows:
            coords:List[float] = json.loads(row[0]) if row[0] else []
            signal = row[1]
            ping = row[2]
            bandwidth = row[3] or 0.0

            weight = calculate_heat_weight(signal, ping, bandwidth)

            results.append({
                "coords": coords,
                "weight": weight,
                "signal_strength": signal,
                "ping_ms": ping,
                "bandwidth": bandwidth
            })
        return results
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching heatmap data: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.post("/api/measurements/cleanup", response_model=HeatmapCleanupResponse)
async def cleanup_measurements(retention_hours: int = Query(default=2160, ge=24, le=24 * 365)) -> HeatmapCleanupResponse:
    try:
        if not DB_NAME:
            logger.error("Invalid Database Name")
            raise ValueError("Database invalid.")
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cutoff = f"-{retention_hours} hours"
        cursor.execute("""
            DELETE FROM wifi_measurements
            WHERE timestamp < datetime('now', ?)
        """, (cutoff,))
        deleted = cursor.rowcount
        conn.commit()
        conn.close()

        return HeatmapCleanupResponse(
            status="success",
            deleted_rows=deleted,
            retention_hours=retention_hours
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cleaning up heatmap data: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/measurements/heatmap/timeline", response_model=HeatmapTimelineResponse)
async def get_heatmap_timeline(
    start_ts: str = Query(..., description="Inclusive start timestamp in ISO-8601"),
    end_ts: str = Query(..., description="Inclusive end timestamp in ISO-8601"),
    bucket_minutes: int = Query(default=10, ge=1, le=120),
    max_frames: int = Query(default=288, ge=1, le=2000),
    limit: int = Query(default=200000, ge=1, le=500000)
) -> HeatmapTimelineResponse:
    try:
        if not DB_NAME:
            logger.error("Invalid Database Name")
            raise ValueError("Database invalid.")

        start_dt = parse_iso_datetime_to_utc(start_ts, "start_ts")
        end_dt = parse_iso_datetime_to_utc(end_ts, "end_ts")
        if start_dt > end_dt:
            raise HTTPException(status_code=400, detail="start_ts must be earlier than or equal to end_ts")

        aligned_start = floor_datetime_to_bucket(start_dt, bucket_minutes)
        aligned_end = floor_datetime_to_bucket(end_dt, bucket_minutes)
        total_frames = int((aligned_end - aligned_start).total_seconds() // (bucket_minutes * 60)) + 1

        if total_frames > max_frames:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Requested range creates {total_frames} frames which exceeds max_frames={max_frames}. "
                    "Reduce range or increase bucket_minutes."
                )
            )

        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT coords, signal_strength, ping_ms, bandwidth, timestamp
            FROM wifi_measurements
            WHERE timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
            LIMIT ?
        """, (
            start_dt.strftime("%Y-%m-%d %H:%M:%S"),
            end_dt.strftime("%Y-%m-%d %H:%M:%S"),
            limit
        ))
        rows = cursor.fetchall()
        conn.close()

        bucket_map: Dict[str, List[HeatmapPointResponse]] = {}
        for row in rows:
            coords: List[float] = json.loads(row[0]) if row[0] else []
            signal = row[1]
            ping = row[2]
            bandwidth = row[3] or 0.0
            ts_raw = row[4]

            row_dt = datetime.fromisoformat(str(ts_raw).replace(' ', 'T'))
            if row_dt.tzinfo is None:
                row_dt = row_dt.replace(tzinfo=timezone.utc)
            row_dt = row_dt.astimezone(timezone.utc)

            bucket_start = floor_datetime_to_bucket(row_dt, bucket_minutes)
            bucket_key = format_utc_iso(bucket_start)

            point = HeatmapPointResponse(
                coords=coords,
                weight=calculate_heat_weight(signal, ping, bandwidth),
                signal_strength=signal,
                ping_ms=ping,
                bandwidth=bandwidth
            )

            if bucket_key not in bucket_map:
                bucket_map[bucket_key] = []
            bucket_map[bucket_key].append(point)

        frames: List[HeatmapTimelineFrame] = []
        cursor_dt = aligned_start
        for _ in range(total_frames):
            frame_start = cursor_dt
            frame_end = cursor_dt + timedelta(minutes=bucket_minutes) - timedelta(seconds=1)
            frame_key = format_utc_iso(frame_start)
            frames.append(HeatmapTimelineFrame(
                frame_start_ts=format_utc_iso(frame_start),
                frame_end_ts=format_utc_iso(frame_end),
                points=bucket_map.get(frame_key, [])
            ))
            cursor_dt = cursor_dt + timedelta(minutes=bucket_minutes)

        return HeatmapTimelineResponse(
            meta=HeatmapTimelineMeta(
                start_ts=format_utc_iso(start_dt),
                end_ts=format_utc_iso(end_dt),
                bucket_minutes=bucket_minutes,
                total_frames=total_frames
            ),
            frames=frames
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching heatmap timeline: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/pois", response_model=List[POIResponse])
async def get_all_pois():
    try:
        if not DB_NAME:
            logger.error("Invalid Database Name")
            raise ValueError("Database invalid.")
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute('''
            SELECT id, name, alias, layer_type, building, floor, coords, floor_images, details
            FROM campus_pois
        ''')
        rows = cursor.fetchall()
        conn.close()
        results: List[Dict[str, Any]] = [
            {
                "id": row[0],
                "name": row[1],
                "alias": row[2],
                "layer_type": row[3],
                "building": row[4],
                "floor": row[5],
                "coords": json.loads(row[6]) if row[6] else [],
                "floor_images": json.loads(row[7]) if row[7] else {},
                "details": json.loads(row[8]) if row[8] else {},
            }
            for row in rows
        ]
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/layers/{layerType}", response_model=List[POIResponse])
async def get_layer_items(layerType: str):
    try:
        if not DB_NAME:
            logger.error("Invalid Database Name")
            raise ValueError("Database invalid.")
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute('''
            SELECT id, name, alias, layer_type, building, floor, coords, floor_images
            FROM campus_pois 
            WHERE layer_type = ?
        ''', (layerType,))
        rows = cursor.fetchall()
        conn.close()
        results: List[Dict[str, Any]] = [
            {
                "id": row[0],
                "name": row[1],
                "alias": row[2],
                "layer_type": row[3],
                "building": row[4],
                "floor": row[5],
                "coords": json.loads(row[6]) if row[6] else [],
                "floor_images": json.loads(row[7]) if row[7] else {},
            }
            for row in rows
        ]
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/health")
async def heart_beat():
    return {"status": "ok", "message": "NetSFC Server is running"}

@app.post("/api/assistant/chat", response_model=AssistantQueryResponse)
async def assistant_chat(request: AssistantQueryRequest) -> AssistantQueryResponse:
    question = request.question.strip()
    if len(question) < 3:
        raise HTTPException(status_code=400, detail="Question is too short")

    result = await asyncio.to_thread(run_assistant_tools_flow, question, request.user_lat, request.user_lng)

    return AssistantQueryResponse(
        answer=result["answer"],
        model=CHATGPT_MODEL,
        action=AssistantAction(**result["action"]),
    )

