require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 4000);
const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 5 * 60 * 1000);
const MAX_LOOKBACK_HOURS = 24;
const WIND_BASE_URL = process.env.WIND_BASE_URL || 'https://a.windbornesystems.com/treasure';
const EARTHQUAKE_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || true }));
app.use(express.json());

const cache = {
  frames: [],
  balloons: [],
  earthquakes: [],
  meta: {
    lastRefresh: null,
    etag: '0',
    datasetNote: 'I picked the USGS real-time earthquake GeoJSON feed because it is unauthenticated, global, and adds high-impact geophysical context to the balloon constellation.'
  },
  questions: []
};

app.get('/health', (_req, res) => {
  res.json({ ok: true, lastRefresh: cache.meta.lastRefresh });
});

app.get('/api/constellation', (req, res) => {
  if (req.headers['if-none-match'] === cache.meta.etag) {
    return res.sendStatus(304);
  }

  res.set('ETag', cache.meta.etag);
  res.json({
    balloons: cache.balloons,
    frames: cache.frames.map(({ hourTag, timestamp, recordCount }) => ({ hourTag, timestamp, recordCount })),
    earthquakes: cache.earthquakes.slice(0, 10),
    meta: cache.meta
  });
});

app.get('/api/balloons/:id', (req, res) => {
  const balloon = cache.balloons.find((item) => item.balloonId === req.params.id);
  if (!balloon) {
    return res.status(404).json({ error: 'Balloon not found' });
  }

  res.json(balloon);
});

app.get('/api/earthquakes', (_req, res) => {
  res.json({ earthquakes: cache.earthquakes, meta: cache.meta });
});

app.post('/api/questions', (req, res) => {
  const { message, contact } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing question text in "message"' });
  }
  if (!contact || typeof contact !== 'string') {
    return res.status(400).json({ error: 'Please include contact info in "contact"' });
  }

  const entry = {
    id: Date.now().toString(36),
    message: message.trim(),
    contact: contact.trim(),
    receivedAt: new Date().toISOString()
  };
  cache.questions.push(entry);
  console.log('New question received:', entry);
  res.status(202).json({ ok: true, received: entry });
});

async function refreshData() {
  const [frames, earthquakes] = await Promise.all([loadWindborneHistory(), fetchEarthquakes()]);

  const balloons = attachNearestEarthquake(buildBalloonTracks(frames), earthquakes);
  cache.frames = frames;
  cache.earthquakes = earthquakes;
  cache.balloons = balloons;
  cache.meta.lastRefresh = new Date().toISOString();
  cache.meta.etag = Date.now().toString(36);
}

async function loadWindborneHistory() {
  const now = Date.now();
  const jobs = [];

  for (let i = 0; i < MAX_LOOKBACK_HOURS; i += 1) {
    jobs.push(fetchWindborneFrame(i, now));
  }

  const frames = (await Promise.all(jobs)).filter(Boolean);
  frames.sort((a, b) => a.timestamp - b.timestamp);
  return frames;
}

async function fetchWindborneFrame(hourOffset, nowMs) {
  const hourTag = hourOffset.toString().padStart(2, '0');
  const url = `${WIND_BASE_URL}/${hourTag}.json`;

  try {
    const response = await axios.get(url, { timeout: 10000 });
    if (!response?.data) return null;

    const timestamp = new Date(nowMs - hourOffset * 3600 * 1000);
    return { hourTag, timestamp: timestamp.getTime(), raw: response.data, recordCount: countEntries(response.data) };
  } catch (error) {
    console.warn(`Failed to load ${url}:`, error.message);
    return null;
  }
}

function countEntries(payload) {
  if (!payload) return 0;
  if (Array.isArray(payload)) return payload.length;
  if (typeof payload === 'object') return Object.keys(payload).length;
  return 0;
}

function buildBalloonTracks(frames) {
  const trackMap = new Map();

  frames.forEach((frame) => {
    const entries = unwrapEntries(frame.raw);
    entries.forEach((entry, idx) => {
      const normalized = normalizeBalloon(entry, frame, idx);
      if (!normalized) return;

      const existing = trackMap.get(normalized.balloonId) || { balloonId: normalized.balloonId, track: [] };
      existing.track.push(normalized);
      trackMap.set(normalized.balloonId, existing);
    });
  });

  return Array.from(trackMap.values()).map(finalizeBalloonTrack).filter(Boolean);
}

function unwrapEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  if (typeof payload === 'object') {
    if (Array.isArray(payload.balloons)) return payload.balloons;
    if (Array.isArray(payload.constellation)) return payload.constellation;
    if (typeof payload.data === 'object') return unwrapEntries(payload.data);
    return Object.values(payload);
  }

  return [];
}

function normalizeBalloon(entry, frame, idx) {
  if (!entry) return null;

  if (Array.isArray(entry)) {
    const lat = Number(entry[0]);
    const lon = Number(entry[1]);
    const altitude = Number(entry[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      balloonId: `coord-${frame.hourTag}-${idx}`,
      timestamp: new Date(frame.timestamp).toISOString(),
      hourTag: frame.hourTag,
      lat,
      lon,
      altitude: Number.isFinite(altitude) ? altitude : null,
      speed: null,
      bearing: null,
      raw: { lat: entry[0], lon: entry[1], altitude: entry[2] }
    };
  }

  if (typeof entry !== 'object') return null;

  const balloonId =
    entry.id ||
    entry.balloonId ||
    entry.callsign ||
    entry.name ||
    entry.serial ||
    entry.device ||
    `unknown-${frame.hourTag}-${idx}`;

  const { lat, lon } = extractCoordinates(entry);
  if (!isFinite(lat) || !isFinite(lon)) return null;

  const altitude = pickNumber(entry.altitude, entry.alt, entry.elevation, entry.height);
  const speed = pickNumber(entry.speed, entry.vel, entry.velocity);
  const bearing = pickNumber(entry.bearing, entry.heading, entry.course);

  const timestamp =
    parseTimestamp(entry.timestamp) ||
    parseTimestamp(entry.time) ||
    parseTimestamp(entry.recorded_at) ||
    parseTimestamp(entry.ts) ||
    new Date(frame.timestamp).toISOString();

  return {
    balloonId: String(balloonId),
    timestamp,
    hourTag: frame.hourTag,
    lat,
    lon,
    altitude: altitude ?? null,
    speed: speed ?? null,
    bearing: bearing ?? null,
    raw: entry
  };
}

function extractCoordinates(entry) {
  const location = entry.location || entry.position || entry.coordinates || entry.coord || entry.coords;

  const lat = pickNumber(
    entry.lat,
    entry.latitude,
    location?.lat,
    location?.latitude,
    Array.isArray(location) ? location[1] : null
  );
  const lon = pickNumber(
    entry.lon,
    entry.lng,
    entry.longitude,
    location?.lon,
    location?.lng,
    location?.longitude,
    Array.isArray(location) ? location[0] : null
  );

  return { lat, lon };
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pickNumber(...candidates) {
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function finalizeBalloonTrack(trackObj) {
  if (!trackObj.track.length) return null;

  trackObj.track.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const latest = trackObj.track[trackObj.track.length - 1];
  const earliest = trackObj.track[0];

  const totalDistanceKm = computePathDistance(trackObj.track);
  const altitudeDelta = (latest.altitude ?? 0) - (earliest.altitude ?? 0);

  return {
    ...trackObj,
    latest,
    firstSeen: earliest.timestamp,
    lastSeen: latest.timestamp,
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    altitudeDelta,
    sampleCount: trackObj.track.length
  };
}

function computePathDistance(points) {
  let sum = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!isFinite(prev.lat) || !isFinite(prev.lon) || !isFinite(curr.lat) || !isFinite(curr.lon)) continue;
    sum += haversineKm(prev.lat, prev.lon, curr.lat, curr.lon);
  }
  return sum;
}

async function fetchEarthquakes() {
  try {
    const response = await axios.get(EARTHQUAKE_URL, { timeout: 8000 });
    const features = response?.data?.features;
    if (!Array.isArray(features)) return [];

    return features
      .map((feature) => ({
        id: feature.id,
        magnitude: feature.properties?.mag ?? null,
        place: feature.properties?.place ?? 'Unknown',
        occurredAt: new Date(feature.properties?.time).toISOString(),
        url: feature.properties?.url,
        coordinates: Array.isArray(feature.geometry?.coordinates) ? feature.geometry.coordinates : null
      }))
      .filter((quake) => Array.isArray(quake.coordinates) && quake.coordinates.length >= 2);
  } catch (error) {
    console.warn('Failed to load earthquake feed:', error.message);
    return [];
  }
}

function attachNearestEarthquake(balloons, earthquakes) {
  if (!earthquakes.length) return balloons;

  return balloons.map((balloon) => {
    const { latest } = balloon;
    if (!latest) return balloon;

    let nearest = null;
    let bestDistance = Infinity;

    earthquakes.forEach((quake) => {
      const [lon, lat] = quake.coordinates;
      const distance = haversineKm(lat, lon, latest.lat, latest.lon);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = { ...quake, distanceKm: Number(distance.toFixed(1)) };
      }
    });

    return { ...balloon, nearestEarthquake: nearest };
  });
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function bootstrap() {
  await refreshData();
  setInterval(refreshData, REFRESH_INTERVAL_MS);

  app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });

  // Serve client static build if available (single-host mode)
  try {
    const clientBuildPath = path.join(__dirname, '..', 'client', 'build');
    if (fs.existsSync(clientBuildPath)) {
      console.log('Serving static client build from', clientBuildPath);
      app.use(express.static(clientBuildPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(clientBuildPath, 'index.html'));
      });
    }
  } catch (e) {
    // ignore; the client build isn't present
  }
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap server', err);
  process.exit(1);
});
