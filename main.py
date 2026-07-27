from fastapi import FastAPI, HTTPException, Query, status, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import sqlite3, os, asyncio, json
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

class AssistantQueryResponse(BaseModel):
    answer: str
    model: str
    context: Dict[str, Any]

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

def build_assistant_context(limit_classrooms: int = 120, limit_wifi_points: int = 60) -> Dict[str, Any]:
    if not DB_NAME:
        raise ValueError("Database invalid.")

    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT name, building, floor, details
        FROM campus_pois
        WHERE layer_type = 'classroom'
        ORDER BY name ASC
        LIMIT ?
        """,
        (limit_classrooms,)
    )
    classroom_rows = cursor.fetchall()

    classrooms: List[Dict[str, Any]] = []
    for row in classroom_rows:
        loaded_details: Any = json.loads(row[3]) if row[3] else {}
        details: Dict[str, Any] = cast(Dict[str, Any], loaded_details) if isinstance(loaded_details, dict) else cast(Dict[str, Any], {})
        classrooms.append({
            "name": row[0],
            "building": row[1],
            "floor": row[2],
            "capacity": details.get("capacity"),
            "equipment": details.get("equipment", []),
            "podium_type": details.get("podium_type"),
            "desk_type": details.get("desk_type"),
        })

    cursor.execute(
        """
        SELECT coords,
               AVG(signal_strength) AS avg_signal,
               AVG(ping_ms) AS avg_ping,
               AVG(bandwidth) AS avg_bandwidth,
               COUNT(*) AS samples
        FROM wifi_measurements
        WHERE timestamp >= datetime('now', '-72 hours')
        GROUP BY coords
        ORDER BY avg_signal DESC, avg_bandwidth DESC
        LIMIT ?
        """,
        (limit_wifi_points,)
    )
    wifi_rows = cursor.fetchall()
    conn.close()

    wifi_summary: List[Dict[str, Any]] = []
    for row in wifi_rows:
        loaded_coords: Any = json.loads(row[0]) if row[0] else []
        coords_list: List[Any] = cast(List[Any], loaded_coords) if isinstance(loaded_coords, list) else cast(List[Any], [])
        coords = [float(c) for c in coords_list[:2]] if len(coords_list) >= 2 else []
        signal = float(row[1] or 0.0)
        ping = float(row[2] or 0.0)
        bandwidth = float(row[3] or 0.0)
        weight = calculate_heat_weight(int(round(signal or 0.0)), ping, bandwidth)
        wifi_summary.append({
            "coords": coords,
            "avg_signal_strength": round(signal, 2),
            "avg_ping_ms": round(ping, 2),
            "avg_bandwidth": round(bandwidth, 2),
            "samples": int(row[4] or 0),
            "weight": weight,
        })

    return {
        "classrooms": classrooms,
        "wifi_summary": wifi_summary,
        "source": {
            "classroom_count": len(classrooms),
            "wifi_point_count": len(wifi_summary),
            "window_hours": 72,
        },
    }

def call_chatgpt_api(question: str, context: Dict[str, Any]) -> str:
    if not CHATGPT_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="CHATGPT_API_KEY is not configured. Set it in .env before using /api/assistant/chat"
        )

    system_prompt = (
        "You are an assistant for SFC campus navigation and study planning. "
        "Use ONLY the provided context to answer. "
        "Prioritize recommendations by wifi quality and classroom equipment fit. "
        "If context is insufficient, explicitly say what is missing."
    )
    user_prompt = (
        f"User question:\n{question}\n\n"
        "Context JSON:\n"
        f"{json.dumps(context, ensure_ascii=False)}"
    )

    payload: Dict[str, Any] = {
        "model": CHATGPT_MODEL,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }

    req = urllib.request.Request(
        url="https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {CHATGPT_API_KEY}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            body = response.read().decode("utf-8")
        parsed_raw: Any = json.loads(body)
        parsed: Dict[str, Any] = cast(Dict[str, Any], parsed_raw) if isinstance(parsed_raw, dict) else cast(Dict[str, Any], {})
        choices_any: Any = parsed.get("choices", [])
        choices: List[Any] = cast(List[Any], choices_any) if isinstance(choices_any, list) else cast(List[Any], [])
        if not choices:
            raise HTTPException(status_code=502, detail="ChatGPT response did not include choices")
        first_choice: Dict[str, Any] = cast(Dict[str, Any], choices[0]) if isinstance(choices[0], dict) else cast(Dict[str, Any], {})
        message_any: Any = first_choice.get("message", {})
        message_dict: Dict[str, Any] = cast(Dict[str, Any], message_any if isinstance(message_any, dict) else {})
        content_value = message_dict.get("content", "")
        content = str(content_value).strip()
        if not content:
            raise HTTPException(status_code=502, detail="ChatGPT response content is empty")
        return content
    except HTTPException:
        raise
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore") if hasattr(e, "read") else str(e)
        logger.error(f"ChatGPT API HTTP error: {e.code} {detail}")
        raise HTTPException(status_code=502, detail="ChatGPT API call failed")
    except Exception as e:
        logger.error(f"ChatGPT API error: {str(e)}")
        raise HTTPException(status_code=502, detail="ChatGPT API request failed")

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

    context = build_assistant_context()
    answer = await asyncio.to_thread(call_chatgpt_api, question, context)

    return AssistantQueryResponse(
        answer=answer,
        model=CHATGPT_MODEL,
        context=context.get("source", {}),
    )

