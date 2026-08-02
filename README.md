# NetSFC

NetSFC is a campus map system for Keio University Shonan Fujisawa Campus (SFC).
It combines facility information and real-time Wi-Fi measurements in one map.

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

# AI Advisor - pick one provider and set its key. See .env.example for all options.
AI_PROVIDER=openai
OPENAI_API_KEY=...
# OPENAI_MODEL=gpt-4o-mini
```

Change `RUNTIME` from `PRODUCTION` to `DEBUG` for development. 

#### AI Advisor provider

The AI Advisor (`/api/assistant/chat`) supports multiple LLM providers - pick one with
`AI_PROVIDER` and set the matching API key. See `.env.example` for the full list of
env vars and model overrides for each provider:

| `AI_PROVIDER` | API key env var | Get a key |
|---|---|---|
| `openai` (default) | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| `grok` | `GROK_API_KEY` | https://console.x.ai |
| `gemini` | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `claude` | `ANTHROPIC_API_KEY` | https://console.anthropic.com |

If `AI_PROVIDER` is unset it defaults to `openai`. The legacy `CHATGPT_API_KEY` /
`CHATGPT_MODEL` vars still work as aliases for `OPENAI_API_KEY` / `OPENAI_MODEL`.

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

