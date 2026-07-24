from fastapi import FastAPI, HTTPException, status, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import sqlite3, os, asyncio, json
from typing import Any, Dict, List, Coroutine
from dotenv import load_dotenv
from loguru import logger
from init_db import init_db

load_dotenv()
APITITLE:str | None = os.getenv("APITITLE")
VERSION:str | None = os.getenv("VERSION")
DB_NAME:str | None = os.getenv("DB_NAME")
RUNTIME:str | None = os.getenv("RUNTIME")
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
    layer_type: str
    building: str | None = None
    floor: str | None = None
    coords: list[Any]
    floor_images: dict[str, str] | None = None
    details: dict[str, Any] | None = None

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
        cursor.execute('''
            INSERT INTO wifi_measurements (signal_strength, ping_ms, bandwidth, coords)
            VALUES (?, ?, ?, ?)
        ''', (report.signal_strength, report.ping_ms, report.bandwidth, json.dumps(report.coords, ensure_ascii=False)))
        conn.commit()
        conn.close()
        return {"status": "success", "message": "Measurement recorded"}
    except Exception as e:
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
            SELECT id, name, layer_type, building, floor, coords, floor_images, details
            FROM campus_pois
        ''')
        rows = cursor.fetchall()
        conn.close()
        results: List[Dict[str, Any]] = [
            {
                "id": row[0],
                "name": row[1],
                "layer_type": row[2],
                "building": row[3],
                "floor": row[4],
                "coords": json.loads(row[5]) if row[5] else [],
                "floor_images": json.loads(row[6]) if row[6] else {},
                "details": json.loads(row[7]) if row[7] else {},
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
            SELECT id, name, layer_type, building, floor, coords, floor_images
            FROM campus_pois 
            WHERE layer_type = ?
        ''', (layerType,))
        rows = cursor.fetchall()
        conn.close()
        results: List[Dict[str, Any]] = [
            {
                "id": row[0],
                "name": row[1],
                "layer_type": row[2],
                "building": row[3],
                "floor": row[4],
                "coords": json.loads(row[5]) if row[5] else [],
                "floor_images": json.loads(row[6]) if row[6] else {},
            }
            for row in rows
        ]
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/health")
async def heart_beat():
    return {"status": "ok", "message": "NetSFC Server is running"}

