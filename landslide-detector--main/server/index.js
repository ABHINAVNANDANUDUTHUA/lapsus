const express = require("express");
const cors = require("cors");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const { parse } = require("csv-parse/sync");

const { initSoils, detectSoilType } = require("./soilRaster");

const app = express();
const PORT = 5000;

/* =========================
   INIT
========================= */

initSoils();

app.use(express.json());
app.use(cors());
app.use("/predict", rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/* =========================
   LOAD CSV CALIBRATION
========================= */

const csvData = fs.readFileSync(
  "./data/kerala_soil_calibration_dataset.csv",
  "utf8"
);

const SOIL_TABLE = parse(csvData, {
  columns: true,
  skip_empty_lines: true
});

/* =========================
   DEPTH-WISE CSV LOOKUP
========================= */

function getCSVSoil(depth) {
  const row = SOIL_TABLE.find(
    r => depth >= +r.depth_min_m && depth < +r.depth_max_m
  );

  if (!row) {
    return { c: 25, phi: 32, gamma: 16 };
  }

  return {
    c: +row.cohesion_kPa,
    phi: +row.friction_angle_deg,
    gamma: +row.bulk_density_g_per_cm3 * 9.81
  };
}

/* =========================
   TOPOGRAPHY
========================= */

async function calculateSlope(lat, lon) {
  const offset = 0.001;
  const url =
    `https://api.open-meteo.com/v1/elevation?latitude=` +
    `${lat},${lat+offset},${lat-offset},${lat},${lat}` +
    `&longitude=${lon},${lon},${lon},${lon+offset},${lon-offset}`;

  const res = await axios.get(url, { timeout: 5000 });
  const e = res.data.elevation;

  const R = 6378137;
  const d = offset * Math.PI / 180;
  const latR = lat * Math.PI / 180;

  const dy = R * d * 2;
  const dx = R * d * Math.cos(latR) * 2;

  const dzdx = (e[3] - e[4]) / dx;
  const dzdy = (e[1] - e[2]) / dy;

  const slope = Math.atan(Math.sqrt(dzdx**2 + dzdy**2)) * 180 / Math.PI;
  return { elevation: e[0], slope };
}

/* =========================
   WEATHER
========================= */

async function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}` +
    `&longitude=${lon}&current=precipitation` +
    `&daily=precipitation_sum&past_days=7&forecast_days=0`;

  const r = await axios.get(url, { timeout: 5000 });

  const rain7 = (r.data.daily.precipitation_sum || [])
    .reduce((a, b) => a + (b || 0), 0);

  return {
    rain_current: r.data.current.precipitation || 0,
    rain_7day: rain7
  };
}

/* =========================
   PHYSICS ENGINE
========================= */

function analyze(top, weather, depth, soilType) {

  depth = clamp(depth, 0.5, 15);
  const beta = top.slope * Math.PI / 180;

  let { c, phi, gamma } = getCSVSoil(depth);

  // Minor adjustment by raster soil class
  if (soilType === "clayey") phi -= 1;
  if (soilType === "sandy") phi += 1;

  const m = clamp(
    0.7 * (weather.rain_7day / 200) +
    0.3 * (weather.rain_current / 50),
    0, 1
  );

  phi *= (1 - 0.1 * m);
  gamma += m * 0.35 * 9.81;

  const tau_d = gamma * depth * Math.sin(beta) * Math.cos(beta);
  const u = Math.min(
    9.81 * m * depth * Math.cos(beta)**2,
    0.6 * gamma * depth
  );

  const sigma = Math.max(0, gamma * depth * Math.cos(beta)**2 - u);
  const tau_r = c + sigma * Math.tan(phi * Math.PI / 180);

  const FoS = tau_r / tau_d;

  let level = "Low", prob = 5;
  if (FoS < 1) [level, prob] = ["Extreme", 95];
  else if (FoS < 1.25) [level, prob] = ["High", 75];
  else if (FoS < 1.5) [level, prob] = ["Medium", 40];

  return {
    level,
    FoS: +FoS.toFixed(2),
    cohesion: +c.toFixed(1),
    friction: +phi.toFixed(1),
    shear_strength: +tau_r.toFixed(1),
    shear_stress: +tau_d.toFixed(1),
    probability: prob
  };
}

/* =========================
   API
========================= */

app.post("/predict", async (req, res) => {

  const { lat, lng, depth = 2.5 } = req.body;

  const [top, weather] = await Promise.all([
    calculateSlope(lat, lng),
    fetchWeather(lat, lng)
  ]);

  const soilType = detectSoilType(lat, lng);
  const result = analyze(top, weather, depth, soilType);

  res.json({
    location: { lat, lng, elevation: top.elevation },
    terrain: { slope: top.slope },
    soil: { type: soilType },
    weather,
    depth_m: depth,
    prediction: result,
    model: "Kerala ASC + CSV Calibrated Landslide Engine (FINAL)"
  });
});

/* =========================
   SERVER
========================= */

app.listen(PORT, () =>
  console.log(`🚀 Final Kerala Landslide Engine running on ${PORT}`)
);
