const express = require('express'); 
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());                    // allow all origins for now
app.use(express.json());           // parse JSON bodies
app.use(express.urlencoded({ extended: true })); // safety net

// Simple health-check route to test server
app.get('/', (req, res) => {
    res.send('✅ Landslide backend is running');
});

// --- 1. DATA FETCHING ---

const fetchWeather = async (lat, lon) => {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relativehumidity_2m,precipitation&current_weather=true&timezone=UTC`;
        const response = await axios.get(url);

        const hourly = response.data.hourly || {};
        const times = hourly.time || [];
        const lastIdx = Math.max(0, times.length - 1);

        const temp = (hourly.temperature_2m && hourly.temperature_2m[lastIdx] !== undefined)
            ? hourly.temperature_2m[lastIdx]
            : (response.data.current_weather?.temperature ?? 25);

        const humidity = (hourly.relativehumidity_2m && hourly.relativehumidity_2m[lastIdx] !== undefined)
            ? hourly.relativehumidity_2m[lastIdx]
            : 50;

        const precip = (hourly.precipitation && hourly.precipitation[lastIdx] !== undefined)
            ? hourly.precipitation[lastIdx]
            : 0;

        const code = response.data.current_weather?.weathercode ?? 0;

        return {
            temp,
            humidity,
            rain: precip * 10,
            precip_real: precip,
            code
        };
    } catch (e) {
        console.error("Weather API Error:", e.message);
        return { temp: 25, humidity: 50, rain: 0, precip_real: 0, code: 0 };
    }
};

const fetchSoil = async (lat, lon) => {
    try {
        const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lat=${lat}&lon=${lon}&property=bdod&property=clay&property=sand&depth=0-5cm`;
        const response = await axios.get(url);

        const props = response.data?.properties;

        if (!props) {
            return { bulk_density: 130, clay: 33, sand: 33, silt: 34, isWater: false };
        }

        const layers = props.layers || [];
        const getValFromLayers = (name) => {
            const layer = layers.find(l => l.name === name);
            if (!layer || !layer.depths || !layer.depths[0] || !layer.depths[0].values) return 0;
            return layer.depths[0].values.mean || 0;
        };

        let clay = getValFromLayers('clay');
        let sand = getValFromLayers('sand');
        let bulk_density = getValFromLayers('bdod');

        if (!clay && props.clay && props.clay.values) clay = props.clay.values.mean || clay;
        if (!sand && props.sand && props.sand.values) sand = props.sand.values.mean || sand;
        if (!bulk_density && props.bdod && props.bdod.values) bulk_density = props.bdod.values.mean || bulk_density;

        if (!clay && !sand && !bulk_density) {
            return { bulk_density: 0, clay: 0, sand: 0, silt: 0, isWater: true };
        }

        clay = clay / 10;
        sand = sand / 10;
        let silt = 100 - clay - sand;
        if (silt < 0) silt = 0;

        return { bulk_density, clay, sand, silt, isWater: false };
    } catch (e) {
        console.error("Soil API Error:", e.message);
        return { bulk_density: 130, clay: 33, sand: 33, silt: 34, isWater: false };
    }
};

const calculateSlope = async (lat, lon) => {
    try {
        const offset = 0.002;
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat},${lat + offset},${lat}&longitude=${lon},${lon},${lon + offset}`;
        const response = await axios.get(url);
        const elevations = response.data?.elevation || [];

        const h0 = elevations[0] ?? 0;
        const hNorth = elevations[1] ?? h0;
        const hEast = elevations[2] ?? h0;

        const dist = 220;
        const dz_dx = (hEast - h0) / dist;
        const dz_dy = (hNorth - h0) / dist;
        const rise = Math.sqrt(dz_dx * dz_dx + dz_dy * dz_dy);
        const slopeDeg = Math.atan(rise) * (180 / Math.PI);

        return { elevation: h0, slope: parseFloat(slopeDeg.toFixed(1)) };
    } catch (e) {
        console.error("Elevation API Error:", e.message);
        return { elevation: 0, slope: 0 };
    }
};

// --- 2. INTELLIGENT REASONING ENGINE ---

const calculateLandslideRisk = (features) => {
    const { rain, slope, clay, sand, silt, bulk_density, elevation, temp, code, isWater } = features;

    const isSeaOrWater = isWater || (
        elevation >= -5 && elevation <= 5 &&
        Math.abs(slope) < 0.5 &&
        bulk_density < 20
    );

    if (isSeaOrWater) {
        return {
            level: "Safe",
            reason: "🌊 Water body / Sea detected (flat terrain at sea level). This is not a typical land slope.",
            details: {
                FoS: 100,
                cohesion_base: 0,
                friction_base: 0,
                cohesion_effective: 0,
                friction_effective: 0,
                shear_strength: 0,
                shear_stress: 0
            }
        };
    }

    const isSnow = [71, 73, 75, 77, 85, 86].includes(code) || temp < -1;
    if (isSnow) {
        return {
            level: slope > 30 ? "High" : "Medium",
            reason: "❄️ Ice/Snow detected. Risk is predominantly from Avalanche or Thaw-Slump, not typical soil shear.",
            details: {
                FoS: slope > 30 ? 0.9 : 1.5,
                cohesion_base: 50,
                friction_base: 10,
                cohesion_effective: 50,
                friction_effective: 10,
                shear_strength: 0,
                shear_stress: 0
            }
        };
    }

    const fClay = clay / 100;
    const fSand = sand / 100;
    const fSilt = silt / 100;

    let c = (fClay * 35) + (fSilt * 10) + (fSand * 1);
    let phi = (fSand * 34) + (fSilt * 28) + (fClay * 18);

    let saturationIndex = 0.1;
    if (rain > 800) saturationIndex = 1.0;
    else if (rain > 400) saturationIndex = 0.7;
    else if (rain > 100) saturationIndex = 0.4;

    const c_eff = c * (1 - 0.5 * saturationIndex);
    const phi_eff = phi * (1 - 0.3 * saturationIndex);

    const c_used = Math.max(0, c_eff);
    const phi_used = Math.max(5, phi_eff);

    const gamma = (bulk_density / 100) * 9.81;
    const z = 3.0;
    const beta = slope * (Math.PI / 180);

    const sigma = gamma * z * Math.pow(Math.cos(beta), 2);
    const tau_driving = gamma * z * Math.sin(beta) * Math.cos(beta);

    let u = 0;
    if (rain > 800) u = sigma * 0.5;
    else if (rain > 400) u = sigma * 0.3;
    else if (rain > 100) u = sigma * 0.1;

    const sigma_effective = Math.max(0, sigma - u);
    const tanPhi = Math.tan(phi_used * (Math.PI / 180));

    const tau_resisting = c_used + (sigma_effective * tanPhi);
    let FoS = tau_resisting / (tau_driving + 0.001);

    let probability = 0;
    if (slope < 1) {
        FoS = 20.0;
        probability = 0.01;
    } else {
        if (FoS < 1.0) probability = 0.95;
        else if (FoS < 1.2) probability = 0.75;
        else if (FoS < 1.5) probability = 0.40;
        else if (FoS < 2.0) probability = 0.20;
        else probability = 0.05;
    }

    let level = "Low";
    if (probability > 0.7) level = "High";
    else if (probability > 0.3) level = "Medium";

    let sentences = [];

    if (fClay > 0.45) sentences.push(`The terrain is Clay-rich (${clay.toFixed(0)}%), which is cohesive but slippery when wet.`);
    else if (fSand > 0.6) sentences.push(`The terrain is Sandy (${sand.toFixed(0)}%), which is loose and prone to washout.`);
    else sentences.push(`The soil has a balanced mix of sand, silt, and clay, providing moderate stability.`);

    if (slope > 35) sentences.push(`The slope is extremely steep (${slope}°), making it naturally unstable.`);
    else if (slope < 5) sentences.push(`The land is flat (${slope}°), significantly reducing landslide risk.`);

    if (rain > 400) sentences.push(`⚠️ CRITICAL: Heavy rainfall is saturating the ground, reducing cohesion and friction.`);
    else if (rain > 100) sentences.push(`Moderate rain detected. Pore pressure is increasing and effective strength is reduced.`);

    const reason = sentences.join(" ");

    return {
        level,
        reason,
        details: {
            FoS,
            cohesion_base: Number(c.toFixed(2)),
            friction_base: Number(phi.toFixed(2)),
            cohesion_effective: Number(c_used.toFixed(2)),
            friction_effective: Number(phi_used.toFixed(2)),
            shear_strength: tau_resisting,
            shear_stress: tau_driving
        }
    };
};

// --- 3. ROUTE ---

app.post('/predict', async (req, res) => {
    console.log('🔵 /predict hit, body =', req.body);

    const { lat, lng, manualRain } = req.body;

    if (lat === undefined || lng === undefined) {
        console.warn('⚠️ Missing lat/lng in body');
        return res.status(400).json({ error: 'lat and lng are required' });
    }

    console.log(`📍 Analysis: ${lat}, ${lng} | Rain Override: ${manualRain ?? 'None'}`);

    try {
        const [weather, soil, topo] = await Promise.all([
            fetchWeather(lat, lng),
            fetchSoil(lat, lng),
            calculateSlope(lat, lng)
        ]);

        let features = { ...weather, ...soil, ...topo };
        let isSimulated = false;

        if (manualRain !== null && manualRain !== undefined) {
            features.precip_real = manualRain;
            features.rain = manualRain * 10;
            isSimulated = true;
        }

        const prediction = calculateLandslideRisk(features);
        
        console.log(`📊 Result: ${prediction.level} | ${prediction.reason}`);

        res.json({
            location: { lat, lng },
            data: features,
            prediction: prediction,
            isSimulated: isSimulated
        });

    } catch (error) {
        console.error('❌ /predict error:', error);
        res.status(500).json({ error: "Failed" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Intelligent Physics Engine running on port ${PORT}`);
});


