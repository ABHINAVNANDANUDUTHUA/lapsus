require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const { parse } = require("csv-parse/sync");

const { initSoils, detectSoilClass } = require("./soilGeoTiff");
const { fetchSoilGrids } = require("./soilGrids");
const { fuseSoil } = require("./soilFusion");

const app = express();
app.use(cors());
app.use(express.json());
app.use("/predict", rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

/* ===== INIT ===== */
initSoils();

/* ===== LOAD CSV (PDF CALIBRATION) ===== */
const csv = fs.readFileSync(
  "data/kerala_soil_calibration_dataset.csv",
  "utf8"
);
const SOIL_TABLE = parse(csv, { columns: true });

function getStrength(depth) {
  const r = SOIL_TABLE.find(
    x => depth >= +x.depth_min_m && depth < +x.depth_max_m
  );
  return {
    c: +r.cohesion_kPa,
    phi: +r.friction_angle_deg,
    gamma: +r.bulk_density_g_per_cm3 * 9.81
  };
}

/* ===== TOPOGRAPHY ===== */
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

  return Math.atan(Math.sqrt(dzdx**2 + dzdy**2)) * 180 / Math.PI;
}

/* ===== WEATHER ===== */
async function weather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=precipitation&daily=precipitation_sum&past_days=7&forecast_days=0`;

  const r = await axios.get(url);
  return {
    rain_now: r.data.current.precipitation || 0,
    rain_7: (r.data.daily.precipitation_sum || []).reduce((a,b)=>a+(b||0),0)
  };
}

/* ===== API ===== */
app.post("/predict", async (req, res) => {
  const { lat, lng, depth = 2.5 } = req.body;

  const [β, w] = await Promise.all([
    slope(lat, lng),
    weather(lat, lng)
  ]);

  const soilClass = detectSoilClass(lat, lng);
  const sg = await fetchSoilGrids(lat, lng).catch(() => null);
  const composition = fuseSoil(soilClass, sg);

  const { c, phi, gamma } = getStrength(depth);

  const m = clamp(
    0.7 * (w.rain_7 / 200) + 0.3 * (w.rain_now / 50),
    0, 1
  );

  const beta = β * Math.PI / 180;
  const γ = gamma + m * 0.35 * 9.81;
  const u = Math.min(9.81 * m * depth * Math.cos(beta)**2, 0.6 * γ * depth);
  const τ = γ * depth * Math.sin(beta) * Math.cos(beta);
  const σ = Math.max(0, γ * depth * Math.cos(beta)**2 - u);
  const τr = c + σ * Math.tan(phi * Math.PI / 180);
  const FoS = τr / τ;

  res.json({
    location: { lat, lng },
    slope_deg: +β.toFixed(2),
    soil: {
      class: soilClass,
      composition
    },
    physics: {
      cohesion_kPa: +c.toFixed(1),
      friction_deg: +phi.toFixed(1),
      shear_stress_kPa: +τ.toFixed(2),
      shear_strength_kPa: +τr.toFixed(2),
      FoS: +FoS.toFixed(2)
    },
    model: "Kerala GeoTIFF + SoilGrids + PDF Calibrated Engine (FINAL)"
  });
});

app.listen(5000, () =>
  console.log("🚀 FINAL Kerala landslide engine running on port 5000")
);
