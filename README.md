## Windborne Engineering Challenge

Interactive dashboard that ingests Windborne's live constellation snapshots (last 24 hours) and contextualizes the balloons with the USGS real-time earthquake GeoJSON feed.

### Project structure

- `server/`: Express API that fetches and normalizes the Windborne JSON files (`00.json`–`23.json`) and the earthquake feed, enriches balloons with derived metrics + nearest quake, and exposes `/api/constellation`, `/api/balloons/:id`, and `/api/earthquakes`.
- `client/`: React app (Create React App) that consumes the API, renders live balloon cards, and highlights recent earthquakes.

### Running locally

1. Install dependencies in both folders: `npm install` inside `server` and `client`.
2. Start the backend: `cd server && npm start` (listens on `http://localhost:4000` by default).
3. Start the frontend: `cd client && npm start`. While developing locally, set `REACT_APP_API_BASE=http://localhost:4000` if you are proxying to the backend on another port.

The UI polls the backend every two minutes and shows the last refresh time. Failures display inline error state.

### External dataset choice

I chose the USGS real-time earthquake GeoJSON feed because it is unauthenticated, global in coverage, and provides high-impact contextual events that pair nicely with the balloon constellation’s global telemetry.

### Asking questions

Per the challenge instructions, send questions through a POST request to the backend (e.g. `POST /api/questions` containing contact info). The UI also links this guidance inside its Notes section.

### Deployment

Deploy the Express server to your preferred host (e.g. Render/Fly/Heroku) and expose it over HTTPS. Then build the React app (`npm run build`) and serve it via a static host (Netlify/Vercel/S3) configured to hit the deployed API URL via `REACT_APP_API_BASE`.

### Environment variables
There are environment variables for both the server and the client used to customize runtime behavior and connection endpoints.

- Server: See `server/.env.example`. Key variables:
	- `PORT` — The server port (default `4000`)
	- `REFRESH_INTERVAL_MS` — How often to refresh external feeds (default `300000` ms)
	- `ALLOWED_ORIGINS` — Comma-separated list of allowed origins for CORS. Include your frontend URL(s).
	- `WIND_BASE_URL` — Optional override for the Windborne JSON base URL (default: the public Windborne endpoint)

- Client: See `client/.env.example`. Key variables:
	- `REACT_APP_API_BASE` — The API base URL (e.g., `https://<server>.onrender.com`) used at runtime
	- `REACT_APP_REFRESH_MS` — Poll interval in milliseconds

Set environment variables:

- On Render: select the service → Environment → Environment Variables and add keys/values.
- On Vercel: Project Settings → Environment Variables.
- Locally: copy `server/.env.example` → `server/.env` and `client/.env.example` → `client/.env` and update values. For Node to use `.env`, add `dotenv` to `server` dev dependencies if needed.

Example `.env` (not committed):

`server/.env`:
```
PORT=4000
REFRESH_INTERVAL_MS=300000
ALLOWED_ORIGINS=http://localhost:3000
WIND_BASE_URL=https://a.windbornesystems.com/treasure
```

`client/.env`:
```
REACT_APP_API_BASE=http://localhost:4000
REACT_APP_REFRESH_MS=120000
```

Notes:
- Do not commit `.env` with secrets or credentials; commit only `.env.example`.
- For production, set environment variables via your host dashboard (Render or Vercel) or using repository secrets + CI.
