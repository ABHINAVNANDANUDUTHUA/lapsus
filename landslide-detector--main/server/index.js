/****************************************************
 * KERALA LANDSLIDE PREDICTION ENGINE – FINAL
 * GeoTIFF + SoilGrids + PDF-Calibrated Physics
 * SINGLE FILE VERSION
 ****************************************************/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const GeoTIFF = require("geotiff");
const { parse } = require("csv-parse/sync");

/* ================= BASIC SETUP ================= */

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use("/predict", rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/* ================= LOAD CSV (PDF CALIBRATION) ================= */

const csvText = fs.readFileSync(
  "data/kerala_soil_calibration_dataset.csv",
  "utf8"
);

const SOIL_TABLE = parse(csvText, {
  columns: true,
  skip_empty_lines: true
});

function getStrengthFromCSV(depth) {
  const row = SOIL_TABLE.find(
    r => depth >= +r.depth_min_m && depth < +r.depth_max_m
  );

  if (!row) {
    return { c: 25, phi: 30, gamma: 16 };
  }

  return {
    c: +row.cohesion_kPa,
    phi: +row.friction_angle_deg,
    gamma: +row.bulk_density_g_per_cm3 * 9.81
  };
}

/* ================= LOAD GEOTIFF SOIL MAPS ================= */

const SOIL_TIFS = {
  clayey: "data/soils/fclayey.tif",
  claySkeletal: "data/soils/fclayskeletal.tif",
  loamy: "data/soils/floamy.tif",
  sandy: "data/soils/fsandy.tif"
};

const soilRasters = {};

async function loadTiff(filePath) {
  const buffer = fs.readFileSync(filePath);
  const tiff = await GeoTIFF.fromArrayBuffer(buffer.buffer);
  const image = await tiff.getImage();
  const raster = await image.readRasters();

  return {
    data: raster[0],
    width: image.getWidth(),
    height: image.getHeight(),
    bbox: image.getBoundingBox()
  };
}

async function initSoilTiffs() {
  for (const key of Object.keys(SOIL_TIFS)) {
    soilRasters[key] = await loadTiff(SOIL_TIFS[key]);
  }
  console.log("✅ GeoTIFF soil maps loaded");
}

function getRasterValue(r, lat, lon) {
  const [xmin, ymin, xmax, ymax] = r.bbox;

  const px = Math.floor(((lon - xmin) / (xmax - xmin)) * r.width);
  const py = Math.floor(((ymax - lat) / (ymax - ymin)) * r.height);

  if (px < 0 || py < 0 || px >= r.width || py >= r.height) return null;
  return r.data[py * r.width + px];
}

function detectSoilClass(lat, lon) {
  for (const key of Object.keys(soilRasters)) {
    const v = getRasterValue(soilRasters[key], lat, lon);
    if (v === 1) return key;
  }
  return "unknown";
}

/* ================= SOILGRIDS API ================= */

const SOILGRIDS_KEY = process.env.SOILGRIDS_API_KEY;

async function fetchSoilGrids(lat, lon) {
  const url =
    `https://rest.isric.org/soilgrids/v2.0/properties/query` +
    `?lat=${lat}&lon=${lon}` +
    `&property=clay&property=sand&property=silt&depth=0-5cm`;

  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${SOILGRIDS_KEY}` },
    timeout: 6000
  });

  const layers = r.data.properties.layers;
  const get = n =>
    layers.find(l => l.name === n)?.depths[0]?.values.mean / 10;

  return {
    clay: get("clay"),
    sand: get("sand"),
    silt: get("silt")
  };
}

/* ================= SOIL COMPOSITION FUSION ================= */

function fuseSoilComposition(soilClass, sg, depth) {

  // Base regional composition (Kerala)
  const BASE = {
    clayey:        { clay: 50, sand: 30 },
    claySkeletal:  { clay: 35, sand: 40 },
    loamy:         { clay: 30, sand: 35 },
    sandy:         { clay: 10, sand: 70 },
    unknown:       { clay: 30, sand: 35 }
  };

  let clay = BASE[soilClass]?.clay ?? 30;
  let sand = BASE[soilClass]?.sand ?? 35;

  // Fuse SoilGrids softly
  if (sg && sg.clay && sg.sand) {
    clay = 0.6 * clay + 0.4 * sg.clay;
    sand = 0.6 * sand + 0.4 * sg.sand;
  }

  // Enforce class constraints
  if (soilClass === "clayey") clay = clamp(clay, 40, 70);
  if (soilClass === "sandy") clay = clamp(clay, 5, 20);

  // Depth adjustment (cementation zone)
  if (depth > 3) clay *= 0.9;
  if (depth > 7) clay *= 0.85;

  sand = clamp(sand, 10, 80);
  const silt = 100 - clay - sand;

  return {
    clay: Math.round(clay),
    sand: Math.round(sand),
    silt: Math.round(silt),
    label: soilClass,
    source: "GeoTIFF + SoilGrids (fused)"
  };
}

/* ================= TOPOGRAPHY ================= */

async function calculateSlope(lat, lon) {
  const o = 0.001;
  const url =
    `https://api.open-meteo.com/v1/elevation?latitude=${lat},${lat+o},${lat-o},${lat},${lat}` +
    `&longitude=${lon},${lon},${lon},${lon+o},${lon-o}`;

  const r = await axios.get(url);
  const e = r.data.elevation;

  const R = 6378137;
  const d = o * Math.PI / 180;
  const latR = lat * Math.PI / 180;

  const dy = R * d * 2;
  const dx = R * d * Math.cos(latR) * 2;

  const dzdx = (e[3] - e[4]) / dx;
  const dzdy = (e[1] - e[2]) / dy;

  return {
    elevation: e[0],
    slope: Math.atan(Math.sqrt(dzdx**2 + dzdy**2)) * 180 / Math.PI
  };
}

/* ================= WEATHER ================= */

async function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=precipitation&daily=precipitation_sum&past_days=7&forecast_days=0`;

  const r = await axios.get(url);

  return {
    rain_now: r.data.current.precipitation || 0,
    rain_7day: (r.data.daily.precipitation_sum || []).reduce(
      (a, b) => a + (b || 0), 0
    )
  };
}

/* ================= PHYSICS ================= */

function analyzeSlope(slopeDeg, depth, strength, weather) {
  const beta = slopeDeg * Math.PI / 180;
  const m = clamp(
    0.7 * (weather.rain_7day / 200) +
    0.3 * (weather.rain_now / 50),
    0, 1
  );

  const gamma = strength.gamma + m * 0.35 * 9.81;
  const u = Math.min(
    9.81 * m * depth * Math.cos(beta)**2,
    0.6 * gamma * depth
  );

  const tau = gamma * depth * Math.sin(beta) * Math.cos(beta);
  const sigma = Math.max(0, gamma * depth * Math.cos(beta)**2 - u);
  const tau_r = strength.c + sigma * Math.tan(strength.phi * Math.PI / 180);

  const FoS = tau_r / tau;

  let level = "Low";
  if (FoS < 1) level = "Extreme";
  else if (FoS < 1.25) level = "High";
  else if (FoS < 1.5) level = "Medium";

  return {
    FoS: +FoS.toFixed(2),
    shear_stress: +tau.toFixed(2),
    shear_strength: +tau_r.toFixed(2),
    level
  };
}

/* ================= API ================= */

app.post("/predict", async (req, res) => {

  const { lat, lng, depth = 2.5 } = req.body;

  const [topo, weather] = await Promise.all([
    calculateSlope(lat, lng),
    fetchWeather(lat, lng)
  ]);

  const soilClass = detectSoilClass(lat, lng);
  const sg = await fetchSoilGrids(lat, lng).catch(() => null);
  const composition = fuseSoilComposition(soilClass, sg, depth);

  const strength = getStrengthFromCSV(depth);
  const physics = analyzeSlope(topo.slope, depth, strength, weather);

  res.json({
    location: { lat, lng, elevation: topo.elevation },
    terrain: { slope: +topo.slope.toFixed(2) },
    soil: {
      class: soilClass,
      composition
    },
    physics: {
      cohesion_kPa: strength.c,
      friction_deg: strength.phi,
      ...physics
    },
    depth_used_m: depth,
    model: "Kerala GeoTIFF + SoilGrids + PDF Calibrated Engine (SINGLE FILE)"
  });
});

/* ================= START ================= */

initSoilTiffs().then(() => {
  app.listen(PORT, () =>
    console.log(`🚀 FINAL engine running on port ${PORT}`)
  );
});
