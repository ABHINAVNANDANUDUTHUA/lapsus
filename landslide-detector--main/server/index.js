/****************************************************
 * KERALA LANDSLIDE ENGINE – FINAL STABLE VERSION
 * GeoTIFF + SoilGrids + CSV (PDF calibrated)
 * SINGLE FILE – DEBUG SAFE
 ****************************************************/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const GeoTIFF = require("geotiff").default;
const { parse } = require("csv-parse/sync");

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use("/predict", rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/* ==================================================
   CSV – PDF CALIBRATION
================================================== */

let SOIL_TABLE = [];
try {
  const csvText = fs.readFileSync(
    path.join(__dirname, "data", "kerala_soil_calibration_dataset.csv"),
    "utf8"
  );
  SOIL_TABLE = parse(csvText, { columns: true, skip_empty_lines: true });
  console.log("✅ CSV calibration loaded");
} catch (e) {
  console.error("❌ CSV load failed:", e.message);
}

function getStrength(depth) {
  const row = SOIL_TABLE.find(
    r => depth >= +r.depth_min_m && depth < +r.depth_max_m
  );
  return row
    ? {
        c: +row.cohesion_kPa,
        phi: +row.friction_angle_deg,
        gamma: +row.bulk_density_g_per_cm3 * 9.81
      }
    : { c: 25, phi: 30, gamma: 16 };
}

/* ==================================================
   GEOTIFF SOIL MAPS (ALL 4 FILES)
================================================== */

const SOIL_TIFS = {
  clayey: "fclayey.tif",
  claySkeletal: "fclayskeletal.tif",
  loamy: "floamy.tif",
  sandy: "fsandy.tif"
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
  console.log("🔄 Loading GeoTIFF soil datasets...");
  for (const key in SOIL_TIFS) {
    try {
      const fullPath = path.join(__dirname, "data", "soils", SOIL_TIFS[key]);
      soilRasters[key] = await loadTiff(fullPath);
      console.log(`✅ Loaded ${SOIL_TIFS[key]}`);
    } catch (e) {
      console.error(`❌ Failed to load ${SOIL_TIFS[key]} →`, e.message);
    }
  }

  if (Object.keys(soilRasters).length === 0) {
    throw new Error("No GeoTIFF soil files loaded. Server stopped.");
  }
}

function rasterValue(r, lat, lon) {
  if (!r || !r.bbox) return null;

  const [xmin, ymin, xmax, ymax] = r.bbox;
  const px = Math.floor(((lon - xmin) / (xmax - xmin)) * r.width);
  const py = Math.floor(((ymax - lat) / (ymax - ymin)) * r.height);

  if (px < 0 || py < 0 || px >= r.width || py >= r.height) return null;
  return r.data[py * r.width + px];
}

function detectSoilClass(lat, lon) {
  for (const k in soilRasters) {
    if (rasterValue(soilRasters[k], lat, lon) === 1) return k;
  }
  return "unknown";
}

/* ==================================================
   SOILGRIDS API (SAFE)
================================================== */

async function fetchSoilGrids(lat, lon) {
  if (!process.env.SOILGRIDS_API_KEY) return null;

  try {
    const url =
      `https://rest.isric.org/soilgrids/v2.0/properties/query` +
      `?lat=${lat}&lon=${lon}&property=clay&property=sand&property=silt&depth=0-5cm`;

    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${process.env.SOILGRIDS_API_KEY}` },
      timeout: 5000
    });

    const layers = r.data.properties.layers;
    const get = n =>
      layers.find(l => l.name === n)?.depths[0]?.values.mean / 10;

    return { clay: get("clay"), sand: get("sand"), silt: get("silt") };
  } catch {
    console.warn("⚠️ SoilGrids unavailable");
    return null;
  }
}

/* ==================================================
   SOIL COMPOSITION (FUSED)
================================================== */

function soilComposition(soilClass, sg, depth) {
  const BASE = {
    clayey: { clay: 50, sand: 30 },
    claySkeletal: { clay: 35, sand: 40 },
    loamy: { clay: 30, sand: 35 },
    sandy: { clay: 10, sand: 70 },
    unknown: { clay: 30, sand: 35 }
  };

  let clay = BASE[soilClass].clay;
  let sand = BASE[soilClass].sand;

  if (sg?.clay && sg?.sand) {
    clay = 0.6 * clay + 0.4 * sg.clay;
    sand = 0.6 * sand + 0.4 * sg.sand;
  }

  if (depth > 3) clay *= 0.9;
  if (depth > 7) clay *= 0.85;

  clay = clamp(clay, 5, 70);
  sand = clamp(sand, 10, 80);
  const silt = 100 - clay - sand;

  return {
    clay: Math.round(clay),
    sand: Math.round(sand),
    silt: Math.round(silt),
    label: soilClass
  };
}

/* ==================================================
   TOPOGRAPHY & WEATHER
================================================== */

async function slope(lat, lon) {
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
    slope: Math.atan(Math.sqrt(dzdx ** 2 + dzdy ** 2)) * 180 / Math.PI
  };
}

async function weather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=precipitation&daily=precipitation_sum&past_days=7&forecast_days=0`;

  const r = await axios.get(url);
  return {
    now: r.data.current.precipitation || 0,
    sum7: (r.data.daily.precipitation_sum || []).reduce((a, b) => a + (b || 0), 0)
  };
}

/* ==================================================
   API
================================================== */

app.post("/predict", async (req, res) => {
  const { lat, lng, depth = 2.5 } = req.body;

  const [topo, w] = await Promise.all([slope(lat, lng), weather(lat, lng)]);
  const soilClass = detectSoilClass(lat, lng);
  const sg = await fetchSoilGrids(lat, lng);
  const comp = soilComposition(soilClass, sg, depth);
  const strength = getStrength(depth);

  const beta = topo.slope * Math.PI / 180;
  const m = clamp(0.7 * (w.sum7 / 200) + 0.3 * (w.now / 50), 0, 1);
  const gamma = strength.gamma + m * 0.35 * 9.81;

  const tau = gamma * depth * Math.sin(beta) * Math.cos(beta);
  const u = Math.min(9.81 * m * depth * Math.cos(beta) ** 2, 0.6 * gamma * depth);
  const sigma = Math.max(0, gamma * depth * Math.cos(beta) ** 2 - u);
  const tau_r = strength.c + sigma * Math.tan(strength.phi * Math.PI / 180);
  const FoS = tau_r / tau;

  res.json({
    location: { lat, lng, elevation: topo.elevation },
    slope_deg: +topo.slope.toFixed(2),
    soil: { class: soilClass, composition: comp },
    physics: {
      cohesion_kPa: strength.c,
      friction_deg: strength.phi,
      shear_stress: +tau.toFixed(2),
      shear_strength: +tau_r.toFixed(2),
      FoS: +FoS.toFixed(2)
    }
  });
});

/* ==================================================
   START SERVER
================================================== */

initSoilTiffs().then(() => {
  app.listen(PORT, () =>
    console.log(`🚀 Backend running on http://localhost:${PORT}`)
  );
});
