const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 5000;

/* =========================
   MIDDLEWARE
========================= */

app.use(express.json());
app.use(cors({ origin: '*', methods: ['POST'] }));

app.use('/predict', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
}));

/* =========================
   UTILS
========================= */

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/* =========================
   TOPOGRAPHY
========================= */

const calculateSlope = async (lat, lon) => {
  try {
    const offset = 0.001;
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat},${lat+offset},${lat-offset},${lat},${lat}&longitude=${lon},${lon},${lon},${lon+offset},${lon-offset}`;
    const res = await axios.get(url, { timeout: 5000 });
    const e = res.data.elevation;
    if (!e || e.includes(null)) throw new Error();

    const [hC, hN, hS, hE, hW] = e;
    const R = 6378137;
    const d = offset * Math.PI / 180;
    const latR = lat * Math.PI / 180;

    const dy = R * d * 2;
    const dx = R * d * Math.cos(latR) * 2;

    const dzdx = (hE - hW) / dx;
    const dzdy = (hN - hS) / dy;

    const slope = Math.atan(Math.sqrt(dzdx**2 + dzdy**2)) * 180 / Math.PI;

    return {
      elevation: hC,
      slope: +slope.toFixed(2),
      valid: true
    };
  } catch {
    return { elevation: null, slope: null, valid: false };
  }
};

/* =========================
   WEATHER
========================= */

const fetchWeather = async (lat, lon) => {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=precipitation&daily=precipitation_sum&past_days=7&forecast_days=0`;
    const res = await axios.get(url, { timeout: 5000 });

    const rain7 = (res.data.daily.precipitation_sum || [])
      .reduce((a, b) => a + (b || 0), 0);

    return {
      rain_current: res.data.current.precipitation || 0,
      rain_7day: rain7
    };
  } catch {
    return { rain_current: 0, rain_7day: 0 };
  }
};

/* =========================
   CONTINUOUS SSI MODEL
========================= */

const getSSI = (depth) => {
  // Smooth depth-normalized SSI (Kerala-calibrated)
  return clamp(0.75 * Math.exp(-depth / 6) + 0.2, 0.25, 0.85);
};

const SSItoStrength = (ssi, m, depth) => {

  // Base strength from SSI
  let c = 10 + ssi * 35;       // 10–45 kPa
  let phi = 26 + ssi * 10;     // 26–36°

  // φ–c coupling (real soil behavior)
  phi -= 0.05 * (c - 25);

  // Moisture-dependent φ reduction
  phi *= (1 - 0.1 * m);

  // Regolith weakening at depth > 8 m
  if (depth > 8) c *= 0.8;

  // Bias correction from PDF residuals
  c *= 0.9;
  phi *= 1.05;

  // Unit weight
  const gamma = 14 + ssi * 4 + (m * 0.35 * 9.81);

  return {
    c: clamp(c, 8, 45),
    phi: clamp(phi, 26, 38),
    gamma
  };
};

/* =========================
   PHYSICS ENGINE
========================= */

const analyzeLandslideRisk = (topo, weather, depth) => {

  if (!topo.valid || topo.slope < 5 || topo.slope > 45) {
    return { level: "Invalid", reason: "Model not applicable" };
  }

  depth = clamp(depth, 0.5, 15);
  const beta = topo.slope * Math.PI / 180;

  // Rainfall → saturation (0–200 mm)
  const m_hist = clamp(weather.rain_7day / 200, 0, 0.8);
  const m_evt  = clamp(weather.rain_current / 50, 0, 0.4);
  const m = clamp(0.7 * m_hist + 0.3 * m_evt, 0, 1);

  const ssi = getSSI(depth);
  const { c, phi, gamma } = SSItoStrength(ssi, m, depth);

  const tau_d = gamma * depth * Math.sin(beta) * Math.cos(beta);

  let u = 9.81 * m * depth * Math.cos(beta)**2;
  u = Math.min(u, 0.6 * gamma * depth);

  const sigma_eff = Math.max(0, gamma * depth * Math.cos(beta)**2 - u);
  const tau_r = c + sigma_eff * Math.tan(phi * Math.PI / 180);

  const FoS = tau_r / tau_d;

  let level = "Low", prob = 5;
  if (FoS < 1) [level, prob] = ["Extreme", 95];
  else if (FoS < 1.25) [level, prob] = ["High", 75];
  else if (FoS < 1.5) [level, prob] = ["Medium", 40];

  return {
    level,
    physics: {
      FoS: +FoS.toFixed(2),
      probability: prob,
      cohesion: +c.toFixed(1),
      friction_angle: +phi.toFixed(1),
      unit_weight: +gamma.toFixed(1),
      saturation_ratio: +m.toFixed(2),
      SSI: +ssi.toFixed(2)
    }
  };
};

/* =========================
   API ENDPOINT
========================= */

app.post('/predict', async (req, res) => {

  const { lat, lng, depth = 2.5 } = req.body;

  if (
    typeof lat !== 'number' || lat < 8 || lat > 13.5 ||
    typeof lng !== 'number' || lng < 74 || lng > 78
  ) {
    return res.status(400).json({ error: "Invalid Kerala coordinates" });
  }

  const [topo, weather] = await Promise.all([
    calculateSlope(lat, lng),
    fetchWeather(lat, lng)
  ]);

  const analysis = analyzeLandslideRisk(topo, weather, depth);

  res.json({
    location: {
      lat, lng,
      elevation: topo.elevation,
      slope: topo.slope
    },
    prediction: {
      ...analysis,
      model: "Kerala SSI-Calibrated Infinite Slope (Final)",
      depth_range_m: "0–15",
      rainfall_range_mm: "0–200",
      disclaimer: "Regional-scale assessment only"
    }
  });
});

/* =========================
   SERVER
========================= */

app.listen(PORT, () =>
  console.log(`🚀 Kerala SSI Landslide Engine (FINAL) running on port ${PORT}`)
);
