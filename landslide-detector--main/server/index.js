const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 5000;

/* =========================
   SECURITY & MIDDLEWARE
========================= */

app.use(express.json());

app.use(cors({
    origin: '*', // restrict later if needed
    methods: ['POST']
}));

app.use('/predict', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
}));

/* =========================
   UTILS
========================= */

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/* =========================
   TOPOGRAPHY (SLOPE)
========================= */

const calculateSlope = async (lat, lon) => {
    try {
        const offset = 0.001;
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat},${lat + offset},${lat - offset},${lat},${lat}&longitude=${lon},${lon},${lon},${lon + offset},${lon - offset}`;
        const res = await axios.get(url, { timeout: 5000 });
        const e = res.data.elevation;
        if (!e || e.includes(null)) throw new Error();

        const [hC, hN, hS, hE, hW] = e;

        const R = 6378137;
        const dLat = offset * Math.PI / 180;
        const dLon = offset * Math.PI / 180;
        const latRad = lat * Math.PI / 180;

        const dy = R * dLat * 2;
        const dx = R * dLon * Math.cos(latRad) * 2;

        const dzdx = (hE - hW) / dx;
        const dzdy = (hN - hS) / dy;

        const slope = Math.atan(Math.sqrt(dzdx ** 2 + dzdy ** 2)) * 180 / Math.PI;
        let aspect = Math.atan2(dzdy, -dzdx) * 180 / Math.PI;
        if (aspect < 0) aspect += 360;

        return {
            elevation: hC,
            slope: +slope.toFixed(2),
            aspect: +aspect.toFixed(0),
            valid: true
        };

    } catch {
        return { elevation: null, slope: null, aspect: null, valid: false };
    }
};

/* =========================
   WEATHER (RAIN)
========================= */

const fetchWeather = async (lat, lon) => {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=precipitation&daily=precipitation_sum&past_days=7&forecast_days=0`;
        const res = await axios.get(url, { timeout: 5000 });

        const rain7 = (res.data.daily.precipitation_sum || [])
            .reduce((a, b) => a + (b || 0), 0);

        return {
            rain_current: res.data.current.precipitation || 0,
            rain_7day: rain7,
            valid: true
        };
    } catch {
        return { rain_current: 0, rain_7day: 0, valid: false };
    }
};

/* =========================
   KERALA SOIL ENVELOPES
========================= */

const keralaSoilEnvelope = (depth) => {

    if (depth < 1) {
        return {
            c: [10, 25],
            phi: [26, 30],
            gamma: [14, 16]
        };
    }
    if (depth < 3) {
        return {
            c: [20, 45],
            phi: [30, 34],
            gamma: [15, 17]
        };
    }
    if (depth < 7) {
        return {
            c: [15, 30],
            phi: [32, 36],
            gamma: [16, 18]
        };
    }
    return {
        c: [8, 20],
        phi: [34, 38],
        gamma: [18, 21]
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

    const env = keralaSoilEnvelope(depth);

    const c = (env.c[0] + env.c[1]) / 2;
    const phi = (env.phi[0] + env.phi[1]) / 2;
    const gamma_dry = (env.gamma[0] + env.gamma[1]) / 2;

    const beta = topo.slope * Math.PI / 180;
    const G = 9.81;

    const saturation_history = clamp(weather.rain_7day / 200, 0, 0.8);
    const saturation_event = clamp(weather.rain_current / 50, 0, 0.4);

    const m = clamp((0.7 * saturation_history) + (0.3 * saturation_event), 0, 1);

    const gamma = gamma_dry + (m * 0.35 * 9.81);

    const tau_d = gamma * depth * Math.sin(beta) * Math.cos(beta);

    let u = 9.81 * m * depth * Math.pow(Math.cos(beta), 2);
    u = Math.min(u, 0.6 * gamma * depth);

    const sigma_eff = Math.max(0, gamma * depth * Math.pow(Math.cos(beta), 2) - u);
    const tau_r = c + sigma_eff * Math.tan(phi * Math.PI / 180);

    const FoS = tau_r / tau_d;

    let level = "Low", probability = 5;
    if (FoS < 1.0) [level, probability] = ["Extreme", 95];
    else if (FoS < 1.25) [level, probability] = ["High", 75];
    else if (FoS < 1.5) [level, probability] = ["Medium", 40];

    return {
        level,
        physics: {
            FoS: +FoS.toFixed(2),
            probability,
            cohesion: +c.toFixed(1),
            friction_angle: +phi.toFixed(1),
            unit_weight: +gamma.toFixed(1),
            pore_pressure_ratio: +m.toFixed(2)
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
            lat,
            lng,
            elevation: topo.elevation,
            slope: topo.slope,
            aspect: topo.aspect
        },
        prediction: {
            ...analysis,
            model: "Kerala-Calibrated Infinite Slope",
            valid_for_depth_m: "0–15",
            rainfall_range_mm: "0–200",
            disclaimer: "Regional-scale assessment only"
        }
    });
});

/* =========================
   SERVER
========================= */

app.listen(PORT, () =>
    console.log(`🚀 Kerala Landslide Engine running on port ${PORT}`)
);
