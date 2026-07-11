"use strict";

const VERSION = "0.1.1";
const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter"
];

const state = {
  map: null,
  userMarker: null,
  accuracyCircle: null,
  routeLayer: null,
  currentPosition: null,
  installPrompt: null
};

const $ = id => document.getElementById(id);

function setStatus(text) {
  $("statusText").textContent = text;
}

function initMap() {
  state.map = L.map("map", { zoomControl: true }).setView([50.85, 4.35], 8);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap-bijdragers"
  }).addTo(state.map);
  state.routeLayer = L.featureGroup().addTo(state.map);
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Deze browser ondersteunt geen locatiebepaling."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 15000
    });
  });
}

function showUserPosition(position) {
  const { latitude, longitude, accuracy } = position.coords;
  state.currentPosition = { lat: latitude, lon: longitude };
  const latlng = [latitude, longitude];

  if (state.userMarker) {
    state.userMarker.setLatLng(latlng);
    state.accuracyCircle.setLatLng(latlng).setRadius(accuracy || 0);
  } else {
    state.userMarker = L.circleMarker(latlng, {
      radius: 9,
      color: "#fff",
      weight: 3,
      fillColor: "#1877f2",
      fillOpacity: 1
    }).bindPopup("Jouw huidige locatie").addTo(state.map);
    state.accuracyCircle = L.circle(latlng, {
      radius: accuracy || 0,
      color: "#1877f2",
      weight: 1,
      fillOpacity: 0.08
    }).addTo(state.map);
  }
  state.map.setView(latlng, 13);
}

function validateInputs() {
  const radius = Number($("radiusKm").value);
  const minKm = Number($("minKm").value);
  const maxKm = Number($("maxKm").value);
  if (!Number.isFinite(radius) || radius < 1 || radius > 50) throw new Error("Kies een straal tussen 1 en 50 km.");
  if (!Number.isFinite(minKm) || minKm < 0) throw new Error("De minimumafstand is ongeldig.");
  if (!Number.isFinite(maxKm) || maxKm <= 0) throw new Error("De maximumafstand is ongeldig.");
  if (minKm > maxKm) throw new Error("De minimumafstand mag niet groter zijn dan de maximumafstand.");
  return { radius, minKm, maxKm };
}

function buildQuery(lat, lon, radiusKm) {
  const radiusM = Math.round(radiusKm * 1000);
  return `[out:json][timeout:45];
    relation(around:${radiusM},${lat},${lon})[type=route][route~"^(hiking|foot|walking)$"];
    out body geom;`;
}

async function fetchOverpass(query) {
  let lastError = null;
  for (const endpoint of OVERPASS_SERVERS) {
    try {
      setStatus(`Wandelroutes ophalen via ${new URL(endpoint).hostname}...`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 55000);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`Serverfout ${response.status}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.elements)) throw new Error("Ongeldig antwoord van de routeserver.");
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Geen enkele routeserver antwoordde. ${lastError?.message || ""}`.trim());
}

function parseTaggedDistance(tags) {
  const raw = tags.distance || tags.length || "";
  const match = String(raw).replace(",", ".").match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  let value = Number(match[1]);
  if (/\bm\b/i.test(String(raw)) && !/km/i.test(String(raw))) value /= 1000;
  return value;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function extractSegments(element) {
  const segments = [];
  const seenWays = new Set();
  for (const member of element.members || []) {
    if (member.type !== "way" || seenWays.has(member.ref)) continue;
    seenWays.add(member.ref);
    if (Array.isArray(member.geometry) && member.geometry.length > 1) {
      segments.push(member.geometry.map(p => ({ lat: p.lat, lon: p.lon })));
    }
  }
  return segments;
}

function estimateLengthKm(segments) {
  let total = 0;
  for (const segment of segments) {
    for (let i = 1; i < segment.length; i++) total += haversineKm(segment[i - 1], segment[i]);
  }
  return total;
}

function nearestPoint(segments, user) {
  let best = null;
  let bestDistance = Infinity;
  for (const segment of segments) {
    for (const point of segment) {
      const distance = haversineKm(user, point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }
  }
  return best ? { ...best, distanceKm: bestDistance } : null;
}

function normaliseRoutes(elements, filters, user) {
  return elements.map(element => {
    const tags = element.tags || {};
    const segments = extractSegments(element);
    if (!segments.length) return null;
    const tagged = parseTaggedDistance(tags);
    const estimated = estimateLengthKm(segments);
    const distanceKm = tagged ?? estimated;
    const start = nearestPoint(segments, user);
    return {
      id: element.id,
      name: tags.name || tags.ref || "Naamloze wandelroute",
      network: tags.network || "onbekend netwerk",
      symbol: tags.symbol || "",
      distanceKm,
      segments,
      start
    };
  }).filter(Boolean)
    .filter(route => Number.isFinite(route.distanceKm) && route.distanceKm >= filters.minKm && route.distanceKm <= filters.maxKm)
    .sort((a, b) => (a.start?.distanceKm ?? Infinity) - (b.start?.distanceKm ?? Infinity));
}

function clearRoutes() {
  state.routeLayer.clearLayers();
  $("results").innerHTML = "";
  $("resultCount").textContent = "0 routes";
}

function drawRoute(route, fit = false) {
  state.routeLayer.clearLayers();
  const allLatLngs = [];
  for (const segment of route.segments) {
    const latlngs = segment.map(p => [p.lat, p.lon]);
    allLatLngs.push(...latlngs);
    L.polyline(latlngs, { color: "#d24a35", weight: 5, opacity: 0.9 }).addTo(state.routeLayer);
  }
  if (route.start) {
    L.marker([route.start.lat, route.start.lon]).bindPopup("Dichtstbijzijnde instappunt").addTo(state.routeLayer);
  }
  if (fit && allLatLngs.length) state.map.fitBounds(L.latLngBounds(allLatLngs), { padding: [25, 25] });
}

function renderRoutes(routes) {
  clearRoutes();
  const container = $("results");
  $("resultCount").textContent = `${routes.length} route${routes.length === 1 ? "" : "s"}`;

  if (!routes.length) {
    container.innerHTML = '<div class="empty">Er werden routes opgehaald, maar geen enkele viel binnen de ingestelde afstand van 4 tot 20 km. Probeer tijdelijk minimum 0 en maximum 30 km.</div>';
    return;
  }

  const template = $("routeTemplate");
  routes.forEach((route, index) => {
    const node = template.content.cloneNode(true);
    node.querySelector(".route-name").textContent = route.name;
    node.querySelector(".route-info").textContent = route.network + (route.symbol ? ` · ${route.symbol}` : "");
    node.querySelector(".route-distance").textContent = `${route.distanceKm.toFixed(1).replace(".", ",")} km`;
    node.querySelector(".route-start").textContent = route.start
      ? `Dichtstbijzijnde instappunt: ${route.start.distanceKm.toFixed(1).replace(".", ",")} km van jou`
      : "Instappunt niet beschikbaar";

    node.querySelector(".show-route").addEventListener("click", () => drawRoute(route, true));
    const nav = node.querySelector(".navigate");
    if (route.start) {
      nav.href = `https://www.google.com/maps/dir/?api=1&destination=${route.start.lat},${route.start.lon}&travelmode=driving`;
    } else {
      nav.classList.add("hidden");
    }
    container.appendChild(node);
    if (index === 0) drawRoute(route, false);
  });
}

async function searchRoutes() {
  const button = $("searchBtn");
  try {
    const filters = validateInputs();
    button.disabled = true;
    clearRoutes();
    setStatus("Jouw locatie bepalen...");
    const position = await getPosition();
    showUserPosition(position);
    const user = state.currentPosition;
    setStatus("Wandelroutes zoeken...");
    const data = await fetchOverpass(buildQuery(user.lat, user.lon, filters.radius));
    const rawCount = data.elements.length;
    setStatus(`${rawCount} routes ontvangen; afstanden berekenen...`);
    const routes = normaliseRoutes(data.elements, filters, user);
    renderRoutes(routes);
    setStatus(`${routes.length} geschikte route${routes.length === 1 ? "" : "s"} gevonden uit ${rawCount} ontvangen routes.`);
  } catch (error) {
    console.error(error);
    const message = error?.code === 1
      ? "Locatie niet toegestaan. Geef Chrome toestemming om je locatie te gebruiken."
      : error?.code === 2
        ? "Je locatie kon niet worden bepaald. Controleer of Locatie op je tablet aanstaat."
        : error?.code === 3
          ? "Het bepalen van je locatie duurde te lang. Probeer opnieuw in open lucht."
          : error.message || "Er ging iets mis.";
    setStatus(message);
  } finally {
    button.disabled = false;
  }
}

function setupPwaInstall() {
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    state.installPrompt = event;
    $("installBtn").classList.remove("hidden");
  });
  $("installBtn").addEventListener("click", async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    $("installBtn").classList.add("hidden");
  });
  window.addEventListener("appinstalled", () => $("installBtn").classList.add("hidden"));
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("./sw.js");
    registration.update();
  } catch (error) {
    console.warn("Service worker kon niet worden geregistreerd", error);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  setupPwaInstall();
  registerServiceWorker();
  $("searchBtn").addEventListener("click", searchRoutes);
  console.info(`Walker Pro ${VERSION}`);
});
