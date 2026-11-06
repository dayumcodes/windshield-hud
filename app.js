"use strict";
/* Windshield HUD - all client-side. Position data goes only to OpenStreetMap
   services (Overpass for speed limits, Photon for search, OSRM for routing),
   throttled and on demand. Nothing is stored off-device. */

const $ = id => document.getElementById(id);
const SETTINGS_KEY = "hud-settings-v1";
const state = {
  settings: { unit: "kmh", color: "#5cff9d", layout: "layout-a", scale: 100, offset: 0, mirror: false, flat: true },
  pos: null,            // {lat, lon, speedMps, headingDeg, accuracy}
  limitKmh: null,
  lastLimitQuery: { t: 0, lat: 0, lon: 0 },
  route: null,          // {steps:[{lat,lon,dist,text,arrow,name}], totalDist, totalDur, destName, stepIdx, geometry}
  lastRouteQuery: 0,
  hudOn: false,
  watchId: null,
  wakeLock: null,
  demo: null,
};

/* ---------- settings ---------- */
function loadSettings() {
  try { Object.assign(state.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (e) {}
  applySettings();
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) {} }
function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty("--glow", s.color);
  $("layout").className = "hud-wrap " + s.layout;
  $("layout").style.setProperty("--scale", s.scale / 100);
  $("hudInner").classList.toggle("mirrored", s.mirror);
  $("btnUnmirror").textContent = s.mirror ? "Unmirror" : "Mirror";
  $("unit").textContent = s.unit === "kmh" ? "km/h" : "mph";
  for (const [id, key] of [["segUnit","unit"],["segColor","color"],["segLayout","layout"],["segOffset","offset"],["segMirror","mirror"],["segFlat","flat"]]) {
    const seg = $(id); if (!seg) continue;
    seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", String(s[key]) === b.dataset.v));
  }
}
function bindSeg(id, key, coerce) {
  $(id).querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    state.settings[key] = coerce ? coerce(b.dataset.v) : b.dataset.v;
    saveSettings(); applySettings();
  }));
}

/* ---------- geo helpers ---------- */
const toRad = d => d * Math.PI / 180;
function distM(a, b) {
  const R = 6371000, dLa = toRad(b.lat - a.lat), dLo = toRad(b.lon - a.lon);
  const h = Math.sin(dLa/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLo/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtDist(m, unit) {
  if (m == null) return "--";
  if (unit === "kmh") return m >= 1000 ? (m/1000).toFixed(m >= 10000 ? 0 : 1) + " km" : Math.round(m) + " m";
  const mi = m / 1609.344;
  return mi >= 0.2 ? mi.toFixed(mi >= 10 ? 0 : 1) + " mi" : Math.round(m / 0.3048 / 10) * 10 + " ft";
}
function fmtEta(sec) {
  if (sec == null) return "";
  const t = new Date(Date.now() + sec * 1000);
  return t.getHours().toString().padStart(2,"0") + ":" + t.getMinutes().toString().padStart(2,"0");
}
const ARROWS = { "turn-left":"\u2190", "turn-right":"\u2192", "turn-slight left":"\u2196", "turn-slight right":"\u2197",
  "turn-sharp left":"\u2199", "turn-sharp right":"\u2198", "uturn":"\u21BA", "arrive":"\u2691",
  "roundabout":"\u21BB", "rotary":"\u21BB", "merge":"\u2197", "fork":"\u219F", "continue":"\u2191", "depart":"\u2191" };
function arrowFor(m) {
  if (!m) return "\u2191";
  const t = m.type === "roundabout" || m.type === "rotary" ? m.type : (m.type + (m.modifier ? " " + m.modifier : ""));
  if (m.type === "arrive") return ARROWS["arrive"];
  return ARROWS[t] || ARROWS[m.type] || "\u2191";
}

/* ---------- speed limit (Overpass, throttled) ---------- */
async function updateLimit(p) {
  const now = Date.now();
  if (now - state.lastLimitQuery.t < 45000 && distM(p, state.lastLimitQuery) < 300) return;
  state.lastLimitQuery = { t: now, lat: p.lat, lon: p.lon };
  try {
    const q = `[out:json][timeout:10];way(around:150,${p.lat},${p.lon})["highway"]["maxspeed"];out tags center;`;
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q) });
    const j = await r.json();
    let best = null, bestD = 1e9;
    for (const el of (j.elements || [])) {
      const ms = parseInt(el.tags && el.tags.maxspeed, 10);
      if (!ms || !el.center) continue;
      const d = distM(p, { lat: el.center.lat, lon: el.center.lon });
      if (d < bestD) { bestD = d; best = ms; }
    }
    state.limitKmh = best;
  } catch (e) { /* best-effort: keep previous limit */ }
  renderHud();
}

/* ---------- routing (Photon + OSRM) ---------- */
let searchTimer = null;
function bindSearch() {
  $("destInput").addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = $("destInput").value.trim();
    if (q.length < 3) { $("destResults").innerHTML = ""; return; }
    searchTimer = setTimeout(async () => {
      try {
        const near = state.pos ? `&lat=${state.pos.lat}&lon=${state.pos.lon}` : "";
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5${near}`);
        const j = await r.json();
        $("destResults").innerHTML = "";
        const feats = j.features || [];
        if (!feats.length) { $("destResults").innerHTML = '<button disabled><small>No places found</small></button>'; return; }
        for (const f of feats) {
          const p = f.properties || {};
          const b = document.createElement("button");
          b.innerHTML = `${p.name || q}<small>${[p.street, p.city || p.town || p.village, p.country].filter(Boolean).join(", ")}</small>`;
          b.addEventListener("click", () => { $("destResults").innerHTML = ""; $("destInput").value = p.name || q; planRoute({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }, p.name || q); });
          $("destResults").appendChild(b);
        }
      } catch (e) { $("destResults").innerHTML = '<button disabled><small>Search unavailable</small></button>'; }
    }, 400);
  });
  $("destGo").addEventListener("click", () => {
    const first = $("destResults").querySelector("button");
    if (first) first.click();
  });
  $("routeClear").addEventListener("click", () => { state.route = null; $("routeInfo").hidden = true; $("navRow").hidden = true; });
}
function showRouteMsg(msg) { $("routeInfo").hidden = false; $("routeSummary").textContent = msg; }
async function planRoute(dest, name) {
  if (!state.pos) { showRouteMsg("Waiting for GPS - try again once your position is found."); return; }
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${state.pos.lon},${state.pos.lat};${dest.lon},${dest.lat}?steps=true&overview=full&geometries=geojson`;
    const r = await fetch(url);
    const j = await r.json();
    const route = j.routes && j.routes[0];
    if (!route) return;
    const steps = [];
    for (const leg of route.legs) for (const st of leg.steps)
      steps.push({ lat: st.maneuver.location[1], lon: st.maneuver.location[0], dist: st.distance, dur: st.duration, arrow: arrowFor(st.maneuver), name: st.name || "" });
    state.route = { steps, stepIdx: 0, totalDist: route.distance, totalDur: route.duration, dest, destName: name,
      geometry: (route.geometry && route.geometry.coordinates) || null, lastRoute: Date.now() };
    $("routeInfo").hidden = false;
    $("routeSummary").textContent = `${name} - ${fmtDist(route.distance, state.settings.unit)}, about ${Math.round(route.duration/60)} min`;
    renderHud();
  } catch (e) { showRouteMsg("Routing service unavailable - try again later."); }
}
function showRouteMsg(msg) { $("routeInfo").hidden = false; $("routeSummary").textContent = msg; }
function updateRoute(p) {
  const rt = state.route;
  if (!rt) { $("navRow").hidden = true; $("miniMap").hidden = true; $("curStreet").textContent = ""; $("navEta").textContent = ""; return; }
  while (rt.stepIdx < rt.steps.length - 1 && distM(p, rt.steps[rt.stepIdx]) < 30) rt.stepIdx++;
  const step = rt.steps[rt.stepIdx];
  if (!state.demo && distM(p, step) > 120 && Date.now() - rt.lastRoute > 15000) { rt.lastRoute = Date.now(); planRoute(rt.dest, rt.destName); return; }
  const dStep = distM(p, step);
  let rem = dStep, remDur = 0;
  for (let i = rt.stepIdx; i < rt.steps.length; i++) { rem += rt.steps[i].dist; remDur += rt.steps[i].dur || 0; }
  const speed = (p.speedMps && p.speedMps > 2) ? p.speedMps : (rem / Math.max(remDur, 1)) || 10;
  $("navRow").hidden = false;
  $("navArrow").textContent = step.arrow;
  $("navDist").textContent = fmtDist(dStep, state.settings.unit);
  $("navStreet").textContent = step.name ? "onto " + step.name : "";
  $("curStreet").textContent = step.name || rt.destName;
  $("navEta").textContent = fmtEta(rem / speed) + "  " + fmtDist(rem, state.settings.unit);
  drawMap(p, rt);
  if (rt.stepIdx === rt.steps.length - 1 && dStep < 25) {
    $("routeInfo").hidden = true; $("navRow").hidden = true; $("miniMap").hidden = true;
    $("curStreet").textContent = ""; $("navEta").textContent = ""; state.route = null;
  }
}

/* ---------- HUD rendering ---------- */
function renderHud() {
  const s = state.settings;
  const fresh = state.pos && state.lastPosTs && (Date.now() - state.lastPosTs) < 5000;
  const p = fresh ? state.pos : null;
  let v = null;
  if (p && p.speedMps != null && p.speedMps >= 0) {
    v = s.unit === "kmh" ? p.speedMps * 3.6 : p.speedMps * 2.23694;
    v = Math.max(0, Math.round(v + Number(s.offset)));
  }
  $("speed").textContent = v == null ? "--" : v;
  if (state.limitKmh) {
    $("limit").hidden = false;
    const lim = s.unit === "kmh" ? state.limitKmh : Math.round(state.limitKmh * 0.621371);
    $("limitVal").textContent = lim;
    $("limit").classList.toggle("over", v != null && v > lim + 3);
  } else $("limit").hidden = true;
  if (p && p.headingDeg != null) {
    const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    $("heading").textContent = dirs[Math.round(p.headingDeg / 22.5) % 16] + " " + Math.round(p.headingDeg) + "\u00B0";
  } else $("heading").textContent = "--";
}
setInterval(() => { const d = new Date(); $("clock").textContent = d.getHours().toString().padStart(2,"0") + ":" + d.getMinutes().toString().padStart(2,"0"); renderHud(); }, 1000);

/* ---------- route mini-map (route line only, from OSRM geometry) ---------- */
function drawMap(p, rt) {
  const cv = $("miniMap");
  if (!rt.geometry || rt.geometry.length < 2) { cv.hidden = true; return; }
  cv.hidden = state.settings.layout !== "layout-a";
  if (cv.hidden) return;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
  ctx.clearRect(0, 0, W, H);
  const kx = 111320 * Math.cos(toRad(p.lat)), ky = 110540;
  const hdg = (p.headingDeg != null && p.speedMps > 1) ? p.headingDeg : null;
  const rot = hdg != null ? -hdg : 0;
  const pts = rt.geometry.map(([lo, la]) => {
    let dx = (lo - p.lon) * kx, dy = -(la - p.lat) * ky;
    const r = toRad(rot);
    return [dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)];
  });
  let maxR = 60;
  for (const [x, y] of pts) { const d = Math.hypot(x, y); if (d > maxR) maxR = d; }
  const scale = (W / 2 - 16) / maxR;
  const color = getComputedStyle(document.documentElement).getPropertyValue("--glow").trim() || "#5cff9d";
  ctx.strokeStyle = color; ctx.lineWidth = 7; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.globalAlpha = 0.9; ctx.shadowColor = color; ctx.shadowBlur = 14;
  ctx.beginPath();
  pts.forEach(([x, y], i) => { const X = cx + x * scale, Y = cy - y * scale; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
  ctx.stroke();
  // position arrow (pointing up when heading known)
  ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 12); ctx.lineTo(cx - 8, cy + 8); ctx.lineTo(cx, cy + 3); ctx.lineTo(cx + 8, cy + 8);
  ctx.closePath(); ctx.fill();
}

/* ---------- GPS ---------- */
function onPosition(g) {
  state.pos = { lat: g.coords.latitude, lon: g.coords.longitude,
    speedMps: g.coords.speed, headingDeg: g.coords.heading, accuracy: g.coords.accuracy };
  state.lastPosTs = Date.now(); state.gpsError = false;
  renderHud();
  updateLimit(state.pos);
  updateRoute(state.pos);
}
function startGps() {
  if (state.demo) return startDemo(state.demo);
  if (!("geolocation" in navigator)) { $("speed").textContent = "??"; return; }
  if (state.watchId == null)
    state.watchId = navigator.geolocation.watchPosition(onPosition, () => {
      state.gpsError = true; state.pos = null;
      $("heading").textContent = "no GPS"; $("speed").textContent = "--";
    }, { enableHighAccuracy: true, maximumAge: 1000 });
}

/* ---------- demo mode (?demo=1): simulated drive for testing ---------- */
function startDemo(route) {
  const b = $("demoBadge"); if (b) b.hidden = false;
  let i = 0;
  const tick = () => {
    const pt = route[i % route.length];
    onPosition({ coords: { latitude: pt[0], longitude: pt[1], speed: pt[2], heading: pt[3], accuracy: 5 } });
    i++;
  };
  tick();
  setInterval(tick, 1200);
}
function demoRoute() {
  // a gentle curve so heading and speed vary
  const pts = [];
  let lat = 52.5200, lon = 13.4050, hdg = 90;
  for (let i = 0; i < 200; i++) {
    lat += Math.cos(toRad(hdg)) * 0.00025; lon += Math.sin(toRad(hdg)) * 0.00025;
    hdg += Math.sin(i / 15) * 4;
    pts.push([lat, lon, 8 + Math.abs(Math.sin(i / 8)) * 12, (hdg + 360) % 360]);
  }
  return pts;
}

/* ---------- HUD mode ---------- */
async function enterHud() {
  state.hudOn = true;
  $("home").hidden = true;
  $("hud").hidden = false;
  try { await document.documentElement.requestFullscreen(); } catch (e) {}
  try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function")
      await DeviceOrientationEvent.requestPermission();
  } catch (e) {}
  startGps();
  renderHud();
}
function exitHud() {
  state.hudOn = false;
  $("hud").hidden = true;
  $("home").hidden = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
}
// lay-flat detection
window.addEventListener("deviceorientation", e => {
  if (!state.settings.flat || e.beta == null) return;
  const flat = Math.abs(e.beta) < 18 && Math.abs(e.gamma) < 18;
  if (flat && !state.hudOn) enterHud();
  else if (!flat && state.hudOn) $("hudExit").hidden = false;
});
// tap HUD to reveal exit controls
$("hud").addEventListener("click", () => { $("hudExit").hidden = !$("hudExit").hidden; });
$("btnExit").addEventListener("click", e => { e.stopPropagation(); exitHud(); });
$("btnUnmirror").addEventListener("click", e => {
  e.stopPropagation();
  state.settings.mirror = !state.settings.mirror; saveSettings(); applySettings();
});

/* ---------- init ---------- */
bindSeg("segUnit", "unit");
bindSeg("segColor", "color");
bindSeg("segLayout", "layout");
bindSeg("segOffset", "offset", Number);
bindSeg("segMirror", "mirror", v => v === "on");
bindSeg("segFlat", "flat", v => v === "on");
$("sizeRange").addEventListener("input", () => { state.settings.scale = Number($("sizeRange").value); saveSettings(); applySettings(); });
$("startBtn").addEventListener("click", enterHud);
bindSearch();
loadSettings();
$("sizeRange").value = state.settings.scale;
const params = new URLSearchParams(location.search);
if (params.get("demo") === "1") state.demo = demoRoute();
startGps();
