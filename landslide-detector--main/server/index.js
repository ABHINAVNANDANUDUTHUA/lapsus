const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 5000;

/* ============================
   0. SECURITY & MIDDLEWARE
============================ */

app.use(express.json());

// 🔒 Restrictive CORS
app.use(cors({
    origin: ['http://localhost:3000'], // change to your frontend
    methods: ['POST']
}));

// 🔒 Rate Limiting
app.use('/predict', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
}));

/* ============================
   1. UTILS
============================ */

const isValidNumber = (v, min, max) =>
    typeof v === 'number' && isFinite(v) && v >= min && v <= max;

/* ============================
   2. LIGHTWEIGHT CACHE
============================ */

const topoCache = new Map();
const soilCache = new Map();

const cacheKey = (lat, lon) =>
    `${lat.toFixed(4)},${lon.toFixed(4)}`;

/* ============================
   3. GEODESIC SLOPE CALCULATOR
============================ */

const calculateSlope = async (lat, lon) => {
    const key = cacheKey(lat, lon);
    if (topoCache.has(key)) return topoCache.get(key);

    try {
        const offset = 0.001;
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat},${lat + offset},${lat - offset},${lat},${lat}&longitude=${lon},${lon},${lon},${lon + offset},${lon - offset}`;
        const res = await axios.get(url, { timeout: 5000 });

        const el = res.data.elevation;
        if (!el || el.includes(null)) throw new Error("Invalid elevation data");

        const [hC, hN, hS, hE, hW] = el;

        const R = 6378137;
        const dLat = offset * Math.PI / 180;
        const dLon = offset * Math.PI / 180;
        const latRad = lat * Math.PI / 180;

        const dy = R * dLat * 2;
        const dx = R * dLon * Math.cos(latRad) * 2;

        const dz_dx = (hE - hW) / dx;
        const dz_dy = (hN - hS) / dy;

        const rise = Math.sqrt(dz_dx ** 2 + dz_dy ** 2);
        const slope = Math.atan(rise) * 180 / Math.PI;

        let aspect = Math.atan2(dz_dy, -dz_dx) * 180 / Math.PI;
        if (aspect < 0) aspect += 360;

        const result = {
            elevation: hC,
            slope: +slope.toFixed(2),
            aspect: +aspect.toFixed(0),
            valid: true
        };

        topoCache.set(key, result);
        return result;

    } catch {
        return { elevation: null, slope: null, aspect: null, valid: false };
    }
};

/* ============================
   4. WEATHER
============================ */

const fetchWeather = async (lat, lon) => {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=precipitation&daily=precipitation_sum&past_days=7&forecast_days=0`;
        const res = await axios.get(url, { timeout: 5000 });

        const daily = res.data.daily.precipitation_sum || [];
        const rain7 = daily.reduce((a, b) => a + (b || 0), 0);

        return {
            rain_current: res.data.current.precipitation || 0,
            rain_7day: rain7,
            valid: true
        };
    } catch {
        return { rain_current: 0, rain_7day: 0, valid: false };
    }
};

/* ============================
   5. SOIL
============================ */

const fetchSoil = async (lat, lon) => {
    const key = cacheKey(lat, lon);
    if (soilCache.has(key)) return soilCache.get(key);

    try {
        const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lat=${lat}&lon=${lon}&property=bdod&property=clay&property=sand&depth=0-5cm`;
        const res = await axios.get(url, { timeout: 5000 });

        const layers = res.data.properties.layers;
        const get = n => layers.find(l => l.name === n)?.depths[0]?.values.mean;

        const clay = get('clay');
        const sand = get('sand');
        const bd = get('bdod');

        if (!clay || !sand || !bd) throw new Error();

        const soil = {
            clay: clay / 10,
            sand: sand / 10,
            bulk_density: bd,
            source: "Measured",
            valid: true
        };

        soilCache.set(key, soil);
        return soil;

    } catch {
        return {
            clay: 35,
            sand: 45,
            bulk_density: 145,
            source: "Default Laterite",
            valid: false
        };
    }
};

/* ============================
   6. PHYSICS ENGINE
============================ */

const analyzeLandslideRisk = (lat, topo, weather, soil, depth = 2) => {

    if (!topo.valid || topo.slope < 5 || topo.slope > 45) {
        return { level: "Invalid", reason: "Model not applicable" };
    }

    const beta = topo.slope * Math.PI / 180;
    const G = 9.81;

    let gamma_dry = (soil.bulk_density * 10 * G) / 1000;
    if (gamma_dry < 10) gamma_dry = 16;

    const n = 0.35;
    const gamma_sat = gamma_dry + n * 9.81;

    const m = Math.min(
        Math.min(weather.rain_7day / 250, 0.8) +
        Math.min(weather.rain_current / 40, 0.5),
        1
    );

    const gamma = m > 0.2 ? gamma_sat : gamma_dry;

    let phi = 30 + soil.sand * 0.1;
    let c = 5 + soil.clay * 0.2;

    // uncertainty
    phi *= 0.9 + Math.random() * 0.2;
    c *= 0.8 + Math.random() * 0.4;

    const tau_d = gamma * depth * Math.sin(beta) * Math.cos(beta);

    let u = 9.81 * m * depth * Math.cos(beta) ** 2;
    const u_max = 0.6 * gamma * depth;
    u = Math.min(u, u_max);

    const sigma_eff = Math.max(0, gamma * depth * Math.cos(beta) ** 2 - u);
    const tau_r = c + sigma_eff * Math.tan(phi * Math.PI / 180);

    const FoS = tau_r / tau_d;

    let level = "Low", prob = 5;
    if (FoS < 1) [level, prob] = ["Extreme", 95];
    else if (FoS < 1.25) [level, prob] = ["High", 75];
    else if (FoS < 1.5) [level, prob] = ["Medium", 40];

    let confidence = 100;
    if (!soil.valid) confidence -= 30;
    if (!weather.valid) confidence -= 20;

    return {
        level,
        confidence,
        physics: {
            FoS: +FoS.toFixed(2),
            probability: prob,
            cohesion: +c.toFixed(1),
            friction_angle: +phi.toFixed(1),
            saturation: +m.toFixed(2)
        }
    };
};

/* ============================
   7. API ENDPOINT
============================ */

app.post('/predict', async (req, res) => {

    const { lat, lng, manualRain, depth } = req.body;

    if (
        !isValidNumber(lat, -90, 90) ||
        !isValidNumber(lng, -180, 180)
    ) {
        return res.status(400).json({ error: "Invalid coordinates" });
    }

    const [topo, weather, soil] = await Promise.all([
        calculateSlope(lat, lng),
        fetchWeather(lat, lng),
        fetchSoil(lat, lng)
    ]);

    if (manualRain !== undefined && isValidNumber(manualRain, 0, 500)) {
        weather.rain_current = manualRain;
        weather.rain_7day = manualRain * 5;
    }

    const analysis = analyzeLandslideRisk(lat, topo, weather, soil, depth);

    res.json({
        location: { lat, lng, elevation: topo.elevation },
        prediction: {
            ...analysis,
            model: "Infinite Slope (Conceptual)",
            not_for_design_use: true
        }
    });
});

/* ============================
   8. SERVER
============================ */

app.listen(PORT, () =>
    console.log(`🚀 Landslide Engine running on port ${PORT}`)
);
