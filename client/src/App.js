import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import './App.css';

const API_BASE = process.env.REACT_APP_API_BASE || '';
const REFRESH_MS = Number(process.env.REACT_APP_REFRESH_MS || 120000);
const DEFAULT_QUAKE_RADIUS_KM = 700;
const MAX_VISIBLE_BALLOONS = 400;
const MAX_VISIBLE_TRACKS = 20;

const statusCopy = {
  idle: 'Waiting for data...',
  loading: 'Loading live constellation data...',
  ready: 'Live data streaming',
  error: 'Unable to load data'
};

function App() {
  const [status, setStatus] = useState('idle');
  const [constellation, setConstellation] = useState(null);
  const [earthquakes, setEarthquakes] = useState([]);
  const constellationEtagRef = useRef(null);
  const earthquakeMetaRef = useRef(null);
  const [error, setError] = useState('');
  const [selectedBalloonId, setSelectedBalloonId] = useState(null);
  const [selectedQuakeId, setSelectedQuakeId] = useState(null);
  const [nearbyBalloonIds, setNearbyBalloonIds] = useState([]);
  const [mapFocus, setMapFocus] = useState(null);
  const userInteractedRef = useRef(false);
  const [showTracks, setShowTracks] = useState(false);

  useEffect(() => {
    let timer;
    const fetchAll = async () => {
      setStatus('loading');
      setError('');
      try {
        const [constellationResponse, earthquakesResponse] = await Promise.all([
          fetch(`${API_BASE}/api/constellation`),
          fetch(`${API_BASE}/api/earthquakes`)
        ]);

        if (!constellationResponse.ok) throw new Error(`Constellation error: ${constellationResponse.status}`);
        if (!earthquakesResponse.ok) throw new Error(`Earthquake error: ${earthquakesResponse.status}`);

        const constellationJson = await constellationResponse.json();
        const earthquakesJson = await earthquakesResponse.json();

        if (constellationJson?.meta?.etag && constellationEtagRef.current === constellationJson.meta.etag) {
          // no change
        } else {
          constellationEtagRef.current = constellationJson?.meta?.etag || Date.now().toString();
          setConstellation(constellationJson);
        }

        const incomingEarthquakes = earthquakesJson.earthquakes || [];
        if (earthquakeMetaRef.current?.lastRefresh === earthquakesJson.meta?.lastRefresh) {
          // unchanged
        } else {
          earthquakeMetaRef.current = earthquakesJson.meta || null;
          setEarthquakes(incomingEarthquakes);
        }
        setStatus('ready');
      } catch (err) {
        console.error(err);
        setError(err.message);
        setStatus('error');
      }
    };

    fetchAll();
    timer = setInterval(fetchAll, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const balloons = constellation?.balloons || [];
  const highlightedBalloons = useMemo(() => balloons.slice(0, 12), [balloons]);

  const balloonMarkers = useMemo(() => {
    const result = [];
    const seen = new Set();
    balloons.forEach((balloon) => {
      if (!Number.isFinite(balloon.latest?.lat) || !Number.isFinite(balloon.latest?.lon)) return;
      if (seen.has(balloon.balloonId)) return;
      seen.add(balloon.balloonId);
      result.push({
        id: balloon.balloonId,
        lat: balloon.latest.lat,
        lon: balloon.latest.lon,
        altitude: balloon.latest.altitude ?? null,
        nearestQuakeId: balloon.nearestEarthquake?.id ?? null,
        lastSeen: balloon.lastSeen
      });
    });
    // stable ordering by last seen descending
    result.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
    return result;
  }, [balloons]);

  const balloonMarkerLookup = useMemo(() => {
    const map = new Map();
    balloonMarkers.forEach((marker) => map.set(marker.id, marker));
    return map;
  }, [balloonMarkers]);

  const balloonTracks = useMemo(
    () =>
      balloons
        .map((balloon) => {
          const path = (balloon.track || [])
            .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
            .map((point) => [point.lat, point.lon]);
          if (path.length < 2) return null;
          return { id: balloon.balloonId, path };
        })
        .filter(Boolean)
        .slice(0, MAX_VISIBLE_TRACKS),
    [balloons]
  );

  const visibleBalloonMarkers = useMemo(
    () => balloonMarkers.slice(0, MAX_VISIBLE_BALLOONS),
    [balloonMarkers]
  );

  const quakeMarkers = useMemo(
    () =>
      earthquakes
        .map((quake) => {
          if (!Array.isArray(quake.coordinates)) return null;
          const [lon, lat] = quake.coordinates;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          return { id: quake.id, lat, lon, magnitude: quake.magnitude ?? 0 };
        })
        .filter(Boolean),
    [earthquakes]
  );

  const quakeMarkerLookup = useMemo(() => {
    const map = new Map();
    quakeMarkers.forEach((marker) => map.set(marker.id, marker));
    return map;
  }, [quakeMarkers]);

  useEffect(() => {
    if (mapFocus || userInteractedRef.current || (!balloonMarkers.length && !quakeMarkers.length)) return;
    if (balloonMarkers.length) {
      setMapFocus({ center: [balloonMarkers[0].lat, balloonMarkers[0].lon], zoom: 2 });
    } else if (quakeMarkers.length) {
      setMapFocus({ center: [quakeMarkers[0].lat, quakeMarkers[0].lon], zoom: 2 });
    }
  }, [balloonMarkers, quakeMarkers, mapFocus]);

  const quakeHighlights = useMemo(() => earthquakes.slice(0, 8), [earthquakes]);

  const selectBalloon = useCallback(
    (balloonId, nearestQuakeId, coords, options = {}) => {
      const { focus = true } = options;
      setSelectedBalloonId(balloonId);
      if (nearestQuakeId) {
        setSelectedQuakeId(nearestQuakeId);
        setNearbyBalloonIds(getBalloonIdsNearQuake(nearestQuakeId, balloonMarkers, quakeMarkerLookup));
      } else {
        setSelectedQuakeId(null);
        setNearbyBalloonIds([]);
      }

      if (focus) {
        const marker = coords || balloonMarkerLookup.get(balloonId);
        if (marker) setMapFocus({ center: [marker.lat, marker.lon], zoom: 4 });
      }
    },
    [balloonMarkers, balloonMarkerLookup, quakeMarkerLookup]
  );

  const selectQuake = useCallback(
    (quakeId, nearbyIds, coords) => {
      setSelectedQuakeId(quakeId);
      const ids =
        nearbyIds?.length > 0 ? nearbyIds : getBalloonIdsNearQuake(quakeId, balloonMarkers, quakeMarkerLookup);
      setNearbyBalloonIds(ids);
      if (ids.length) setSelectedBalloonId(ids[0]);

      const marker = coords || quakeMarkerLookup.get(quakeId);
      if (marker) setMapFocus({ center: [marker.lat, marker.lon], zoom: 4 });
    },
    [balloonMarkers, quakeMarkerLookup]
  );

  const handleUserInteraction = useCallback(() => {
    userInteractedRef.current = true;
  }, []);

  return (
    <div className="App">
      <header className="AppHeader">
        <div>
          <p className="eyebrow">Windborne Engineering Challenge</p>
          <h1>Live Balloon Constellation + Earthquake Pulse</h1>
          <p className="subtitle">
            Pulling up to 24 hours of flight history from Windborne and blending it with the USGS real-time
            earthquake GeoJSON feed to explore nearby seismic activity.
          </p>
        </div>
        <div className={`status status-${status}`}>
          <span className="dot" />
          <div>
            <p className="status-label">{statusCopy[status]}</p>
            {constellation?.meta?.lastRefresh && (
              <p className="status-meta">
                Last refreshed {new Date(constellation.meta.lastRefresh).toLocaleTimeString()}
              </p>
            )}
            {status === 'error' && <p className="status-error">{error}</p>}
          </div>
        </div>
      </header>

      <main className="layout">
        <div className="primary-column">
          <section className="panel map-panel">
           <div className="panel-heading">
              <div>
                <h2>Global Map</h2>
                <p className="panel-subtitle">
                  Plotting current balloon locations, optional 24-hour tracks, and the latest earthquakes (scaled by magnitude).
                </p>
                <p className="map-meta">
                  Rendering {visibleBalloonMarkers.length} of {balloonMarkers.length} live balloons to keep the map responsive.
                </p>
              </div>
              <div className="map-legend">
                <div>
                  <span className="legend-dot balloon" /> Balloon
                  <span className="legend-dot quake" /> Earthquake
                </div>
                <button
                  type="button"
                  className="map-toggle"
                  disabled={!balloonTracks.length}
                  onClick={() => setShowTracks((prev) => !prev)}
                  title={
                    balloonTracks.length
                      ? 'Toggle 24-hour tracks for a subset of balloons'
                      : 'No track history available at the moment'
                  }
                >
                  {showTracks ? 'Hide Tracks' : 'Show Tracks'}
                </button>
              </div>
            </div>
            <MapView
              balloonMarkers={visibleBalloonMarkers}
              balloonTracks={balloonTracks}
              quakeMarkers={quakeMarkers}
              selectedBalloonId={selectedBalloonId}
              selectedQuakeId={selectedQuakeId}
              nearbyBalloonIds={nearbyBalloonIds}
              mapFocus={mapFocus}
              onMapFocusConsumed={() => setMapFocus(null)}
              onUserInteraction={handleUserInteraction}
              quakeRadiusKm={DEFAULT_QUAKE_RADIUS_KM}
              showTracks={showTracks}
              onSelectBalloon={selectBalloon}
              onSelectQuake={selectQuake}
            />
          </section>

          <section className="panel">
            <h2>Constellation Snapshot</h2>
            <p className="panel-subtitle">
              Showing {highlightedBalloons.length} of {balloons.length} tracked balloons with freshest telemetry.
            </p>
            <div className="balloon-grid">
              {highlightedBalloons.map((balloon) => (
                <article
                  key={balloon.balloonId}
                  className={`balloon-card ${selectedBalloonId === balloon.balloonId ? 'is-selected' : ''} ${
                    nearbyBalloonIds.includes(balloon.balloonId) ? 'is-near-quake' : ''
                  }`}
                  onClick={() =>
                    selectBalloon(
                      balloon.balloonId,
                      balloon.nearestEarthquake?.id,
                      balloon.latest && { lat: balloon.latest.lat, lon: balloon.latest.lon },
                      { focus: false }
                    )
                  }
                >
                  <header>
                    <h3>{balloon.balloonId}</h3>
                    <p>
                      {formatCoord(balloon.latest?.lat)}°, {formatCoord(balloon.latest?.lon)}°
                    </p>
                  </header>
                  <dl>
                    <div>
                      <dt>Last Seen</dt>
                      <dd>{formatDate(balloon.lastSeen)}</dd>
                    </div>
                    <div>
                      <dt>Altitude Δ</dt>
                      <dd>{formatDelta(balloon.altitudeDelta, 'm')}</dd>
                    </div>
                    <div>
                      <dt>Track Samples</dt>
                      <dd>{balloon.sampleCount ?? 'N/A'}</dd>
                    </div>
                    <div>
                      <dt>Total Distance</dt>
                      <dd>{formatNumber(balloon.totalDistanceKm)} km</dd>
                    </div>
                  </dl>
                  <Sparkline track={balloon.track} />
                  {balloon.nearestEarthquake ? (
                    <footer>
                      <p className="foot-label">Nearest Quake</p>
                      <p className="foot-value">
                        {balloon.nearestEarthquake.place} · {balloon.nearestEarthquake.magnitude ?? '?'}M ·{' '}
                        {balloon.nearestEarthquake.distanceKm} km away
                      </p>
                    </footer>
                  ) : (
                    <footer>
                      <p className="foot-label">Nearest Quake</p>
                      <p className="foot-value">No quake in feed window</p>
                    </footer>
                  )}
                </article>
              ))}
            </div>
          </section>
        </div>

        <section className="panel side-panel">
          <h2>Earthquakes (USGS)</h2>
          <p className="panel-subtitle">Latest eight events within the past 24 hours.</p>
          <ul className="quake-list">
            {quakeHighlights.map((quake) => (
              <li
                key={quake.id}
                className={`quake-card ${selectedQuakeId === quake.id ? 'is-selected' : ''}`}
                onClick={() =>
                  selectQuake(
                    quake.id,
                    null,
                    quake.coordinates ? { lat: quake.coordinates[1], lon: quake.coordinates[0] } : null
                  )
                }
              >
                <div>
                  <p className="quake-mag">{formatNumber(quake.magnitude, 1)}</p>
                  <p className="quake-label">mag</p>
                </div>
                <div className="quake-body">
                  <p className="quake-place">{quake.place}</p>
                  <p className="quake-time">{formatDate(quake.occurredAt)}</p>
                </div>
                <div className="quake-coords">
                  <p>{formatCoord(quake.coordinates?.[1])}°</p>
                  <p>{formatCoord(quake.coordinates?.[0])}°</p>
                </div>
              </li>
            ))}
            {!quakeHighlights.length && <li className="empty">Waiting for earthquake feed...</li>}
          </ul>

          <div className="notes">
            <h3>Notes</h3>
            <p>
              External dataset: I chose the USGS real-time earthquake GeoJSON feed because it is unauthenticated,
              global, and offers high-impact context about seismic events happening near the balloons.
            </p>
            <p>
              Have questions? POST them to our backend (e.g. `POST /api/questions`) with contact info—we will reply
              there per the challenge instructions.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

const MapView = memo(function MapView({
  balloonMarkers,
  balloonTracks,
  quakeMarkers,
  selectedBalloonId,
  selectedQuakeId,
  nearbyBalloonIds = [],
  mapFocus,
  onMapFocusConsumed,
  onUserInteraction,
  quakeRadiusKm,
  showTracks,
  onSelectBalloon,
  onSelectQuake
}) {
  const interactionLockRef = useRef(false);

  return (
    <div className="map-wrapper">
      <MapContainer
        center={[0, 0]}
        zoom={2}
        minZoom={2}
        className="leaflet-map"
        worldCopyJump
        scrollWheelZoom={{ center: true }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapInteractionGuard interactionLockRef={interactionLockRef} onUserInteraction={onUserInteraction} />
        <MapAutoCenter mapFocus={mapFocus} onMapFocusConsumed={onMapFocusConsumed} />
        {showTracks && <TrackLayer tracks={balloonTracks} />}
        <BalloonsLayer
          markers={balloonMarkers}
          selectedBalloonId={selectedBalloonId}
          nearbyBalloonIds={nearbyBalloonIds}
          interactionLockRef={interactionLockRef}
          onSelectBalloon={onSelectBalloon}
        />
        <QuakeLayer
          markers={quakeMarkers}
          selectedQuakeId={selectedQuakeId}
          quakeRadiusKm={quakeRadiusKm}
          balloonMarkers={balloonMarkers}
          interactionLockRef={interactionLockRef}
          onSelectQuake={onSelectQuake}
        />
      </MapContainer>
    </div>
  );
});

function MapInteractionGuard({ interactionLockRef, onUserInteraction }) {
  const map = useMap();
  useEffect(() => {
    const handleStart = () => {
      interactionLockRef.current = true;
      if (onUserInteraction) onUserInteraction();
    };
    const handleEnd = () => {
      interactionLockRef.current = false;
    };
    map.on('dragstart', handleStart);
    map.on('dragend', handleEnd);
    map.on('movestart', handleStart);
    map.on('moveend', handleEnd);
    map.on('zoomstart', handleStart);
    map.on('zoomend', handleEnd);
    return () => {
      map.off('dragstart', handleStart);
      map.off('dragend', handleEnd);
      map.off('movestart', handleStart);
      map.off('moveend', handleEnd);
    };
  }, [interactionLockRef, map]);
  return null;
}

const TrackLayer = memo(function TrackLayer({ tracks }) {
  const map = useMap();
  const layerRef = useRef(null);

  useEffect(() => {
    if (!layerRef.current) {
      layerRef.current = L.layerGroup().addTo(map);
    }
    return () => {
      if (layerRef.current) {
        layerRef.current.remove();
        layerRef.current = null;
      }
    };
  }, [map]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    tracks.forEach((track) => {
      L.polyline(track.path, { color: '#38bdf8', weight: 2, opacity: 0.45 }).addTo(layer);
    });
  }, [tracks]);

  return null;
});

const BalloonsLayer = memo(function BalloonsLayer({
  markers,
  selectedBalloonId,
  nearbyBalloonIds,
  interactionLockRef,
  onSelectBalloon
}) {
  const map = useMap();
  const layerRef = useRef(null);

  useEffect(() => {
    if (!layerRef.current) {
      layerRef.current = L.layerGroup().addTo(map);
    }
    return () => {
      if (layerRef.current) {
        layerRef.current.remove();
        layerRef.current = null;
      }
    };
  }, [map]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const highlightSet = new Set(nearbyBalloonIds);
    markers.forEach((marker) => {
      const isSelected = marker.id === selectedBalloonId;
      const isHighlighted = highlightSet.has(marker.id);
      const circle = L.circleMarker([marker.lat, marker.lon], {
        radius: Math.max(4, Math.min(9, (marker.altitude || 0) / 2000 + 4)),
        color: isSelected ? '#facc15' : isHighlighted ? '#bef264' : '#38bdf8',
        weight: isSelected ? 3 : isHighlighted ? 2 : 1.5,
        fillOpacity: isSelected || isHighlighted ? 1 : 0.7
      });
      circle.on('click', () => {
        if (interactionLockRef.current) return;
        onSelectBalloon(marker.id, marker.nearestQuakeId, { lat: marker.lat, lon: marker.lon });
      });
      circle.bindTooltip(
        `${marker.id}<br/>${formatCoord(marker.lat)}°, ${formatCoord(marker.lon)}°`,
        { direction: 'top', opacity: 0.9, sticky: true }
      );
      circle.addTo(layer);
    });
  }, [markers, nearbyBalloonIds, onSelectBalloon, selectedBalloonId]);

  return null;
});

const QuakeLayer = memo(function QuakeLayer({
  markers,
  selectedQuakeId,
  quakeRadiusKm,
  balloonMarkers,
  interactionLockRef,
  onSelectQuake
}) {
  const map = useMap();
  const layerRef = useRef(null);

  useEffect(() => {
    if (!layerRef.current) {
      layerRef.current = L.layerGroup().addTo(map);
    }
    return () => {
      if (layerRef.current) {
        layerRef.current.remove();
        layerRef.current = null;
      }
    };
  }, [map]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    markers.forEach((marker) => {
      const circle = L.circleMarker([marker.lat, marker.lon], {
        radius: Math.max(5, marker.magnitude * 1.3),
        color: marker.id === selectedQuakeId ? '#f43f5e' : '#f87171',
        weight: marker.id === selectedQuakeId ? 4 : 1.5,
        fillOpacity: marker.id === selectedQuakeId ? 1 : 0.7
      });
      circle.on('click', () => {
        if (interactionLockRef.current) return;
        const nearbyIds = getBalloonIdsAroundQuake(marker, balloonMarkers, quakeRadiusKm);
        onSelectQuake(marker.id, nearbyIds, { lat: marker.lat, lon: marker.lon });
      });
      circle.bindTooltip(
        `${formatNumber(marker.magnitude, 1)}M<br/>${formatCoord(marker.lat)}°, ${formatCoord(marker.lon)}°`,
        { direction: 'top', opacity: 0.9, sticky: true }
      );
      circle.addTo(layer);
    });
  }, [balloonMarkers, markers, onSelectQuake, quakeRadiusKm, selectedQuakeId]);

  return null;
});

function MapAutoCenter({ mapFocus, onMapFocusConsumed }) {
  const map = useMap();

  useEffect(() => {
    if (!mapFocus) return;
    const [lat, lon] = mapFocus.center;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    map.flyTo([lat, lon], mapFocus.zoom ?? 4, { duration: 1.1 });
    if (onMapFocusConsumed) onMapFocusConsumed();
  }, [mapFocus, map, onMapFocusConsumed]);

  return null;
}

function Sparkline({ track }) {
  const points = (track || []).filter((pt) => Number.isFinite(pt.altitude));
  if (points.length < 2) return null;

  const minAltitude = Math.min(...points.map((p) => p.altitude));
  const maxAltitude = Math.max(...points.map((p) => p.altitude));
  const range = maxAltitude - minAltitude || 1;

  const sparkPoints = points.map((pt, idx) => {
    const x = (idx / (points.length - 1)) * 100;
    const y = 30 - ((pt.altitude - minAltitude) / range) * 30;
    return `${x},${y}`;
  });

  return (
    <div className="sparkline">
      <svg viewBox="0 0 100 30" preserveAspectRatio="none">
        <polyline points={sparkPoints.join(' ')} />
      </svg>
      <p>
        Alt trend · {Math.round(minAltitude)}m to {Math.round(maxAltitude)}m
      </p>
    </div>
  );
}

function formatDate(value) {
  if (!value) return 'N/A';
  try {
    const date = new Date(value);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  } catch {
    return value;
  }
}

function formatDelta(value, unit = '') {
  if (value == null || Number.isNaN(value)) return 'N/A';
  const rounded = Math.round(value);
  const display = rounded > 0 ? `+${rounded}` : `${rounded}`;
  return unit ? `${display} ${unit}` : display;
}

function formatNumber(value, decimals = 0) {
  if (value == null || Number.isNaN(Number(value))) return 'N/A';
  const num = Number(value);
  return decimals > 0 ? num.toFixed(decimals) : Math.round(num).toString();
}

function formatCoord(value) {
  return Number.isFinite(value) ? value.toFixed(2) : 'N/A';
}

function getBalloonIdsNearQuake(quakeId, balloonMarkers, quakeLookup, radiusKm = DEFAULT_QUAKE_RADIUS_KM) {
  const quake = quakeLookup.get(quakeId);
  if (!quake) return [];
  return getBalloonIdsAroundQuake(quake, balloonMarkers, radiusKm);
}

function getBalloonIdsAroundQuake(quakeMarker, balloonMarkers, radiusKm) {
  return balloonMarkers
    .filter((marker) => haversineKm(quakeMarker.lat, quakeMarker.lon, marker.lat, marker.lon) <= radiusKm)
    .map((marker) => marker.id);
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

export default App;
