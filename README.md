# NetSFC

NetSFC is a campus map system for Keio University Shonan Fujisawa Campus (SFC).
It combines facility information and real-time Wi-Fi measurements in one map.

## Server Status 

| Server | Status |
| :--- | :--- | 
| Keio SFC Server | <img src="https://status.tianyibrad.com/api/badge/24/status" alt="SFC Server Uptime" /> |
| Backend | <img src="https://status.tianyibrad.com/api/badge/21/status" alt="SFC Server Uptime" /> | 

## Current Status

The project is already in a usable state:

- Frontend and backend are separated.
- Map view, POI panels, and category filters are implemented.
- Wi-Fi heatmap snapshot, timeline replay, and live WebSocket updates are implemented.
- Measurement page (location + network test) is implemented.
- AI campus advisor with local tool-calling is implemented.
- Production deployment is running.

## Main Features

- Interactive campus map with buildings and facility markers
- Classroom/facility detail panels with images and metadata
- Real-time Wi-Fi heatmap
- Heatmap timeline playback
- Measurement ingestion endpoint: `POST /api/measurements`
- Live update endpoint: `WS /ws/heatmap`
- AI assistant endpoint: `POST /api/assistant/chat`

## Architecture

- Backend: FastAPI (`main.py`)
- Database: SQLite
- Frontend: Vanilla HTML/CSS/JavaScript (`frontend/src`)
- Static assets: served under `/data/images`

Frontend uses `window.ENV.API_HOST` in `frontend/src/config.js` to connect to the backend.

Detailed design can be found here: [https://notes.tianyibrad.com/s/nMXo2ggUt](https://notes.tianyibrad.com/s/nMXo2ggUt)

## Quick Start

### 1. Install dependencies

```bash
python3 -m venv .netsfc_pyvenv
source .netsfc_pyvenv/bin/activate
pip install -r requirements.txt
```

or simply run `run.sh` as it would automatically configure for you. 

```bash
./run.sh
```

### 2. Create `.env`

Create a `.env` file in the project root:
An example would be: 
```env
APITITLE=NetSFC API
VERSION=1.0.0
DB_NAME=netsfc.db
HOST=0.0.0.0
PORT=8080
RUNTIME=PRODUCTION
CORS_ORIGINS=http://localhost:5500,http://127.0.0.1:5500
CHATGPT_API_KEY=...
# Optional: 
# CHATGPT_MODEL=gpt-4o-mini
```

Change `RUNTIME` from `PRODUCTION` to `DEBUG` for development. 

### 3. Run backend

```bash
./run.sh
```

Default backend URL: `http://localhost:8080`

### 4. Open frontend pages

- `frontend/src/homepage.html` for the measurement page
- `frontend/src/index.html` for the map page

`frontend/src` can be hosted by any static file server.

## Documentation
Communication format standard can be found in the following file: 
- API: `docs/API.md`
- Database schema: `docs/DATABASE.md`

## Production URLs

- Map: https://ais-official.sfc.keio.ac.jp/map/
- API: https://netsfc-api.tianyibrad.com

