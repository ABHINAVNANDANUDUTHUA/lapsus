const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// ==========================================
// 1. GEODESIC SLOPE CALCULATOR (High Accuracy)
// ==========================================
// Fixes "Mercator Distortion" by calculating real-world distances between grid points.

const calculateSlope = async (lat, lon) => {
    try {
        // High-resolution grid (~111 meters offset)
        const offset = 0.001; 
        
        // Fetch 5 points: Center, North, South, East, West (5-point stencil)
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat},${lat + offset},${lat - offset},${lat},${lat}&longitude=${lon},${lon},${lon},${lon + offset},${lon - offset}`;
        const response = await axios.get(url);
        const el = response.data.elevation;

        const hC = el[0]; // Center
        const hN = el[1]; // North
        const hS = el[2]; // South
        const hE = el[3]; // East
        const hW = el[4]; // West

        if (hC === null) return { elevation: 0, slope: 0, aspect: 0 };

        // 1. Calculate ground distances considering Earth's curvature
        const R = 6378137; // Earth Radius in meters
        const dLat = offset * (Math.PI / 180);
        const dLon = offset * (Math.PI / 180);
        const latRad = lat * (Math.PI / 180);

        // Distance North-South (dy)
        const dy = R * dLat * 2; 

        // Distance East-West (dx) - scales with Cosine of Latitude
        const dx = R * dLon * Math.cos(latRad) * 2;

        // 2. Central Difference Gradient
        const dz_dx = (hE - hW) / dx;
        const dz_dy = (hN - hS) / dy;

        // 3. Slope & Aspect
        const rise = Math.sqrt(dz_dx * dz_dx + dz_dy * dz_dy);
        const slopeDeg = Math.atan(rise) * (180 / Math.PI);

        // Aspect (Direction of water flow)
        let aspectDeg = Math.atan2(dz_dy, -dz_dx) * (180 / Math.PI);
        if (aspectDeg < 0) aspectDeg += 360; // Normalize 0-360

        return { 
            elevation: hC, 
            slope: parseFloat(slopeDeg.toFixed(2)),
            aspect: parseFloat(aspectDeg.toFixed(0))
        };
    } catch (e) {
        console.error("⚠️ Elevation API Error:", e.message);
        return { elevation: 0, slope: 0, aspect: 0 };
    }
};

// ==========================================
// 2. DATA FETCHING (Weather & Soil)
// ==========================================

const fetchWeather = async (lat, lon) => {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=precipitation,weather_code&daily=precipitation_sum,temperature_2m_max&past_days=7&forecast_days=1`;
        const response = await axios.get(url);
        
        const current = response.data.current;
        const daily = response.data.daily;
        
        // Kerala Monsoon Logic: 7-day cumulative is critical for saturation
        const rain_7day = daily.precipitation_sum.slice(0, 7).reduce((a, b) => a + (b || 0), 0);
        
        return { 
            rain_current: current.precipitation, // mm/hour intensity
            rain_7day: rain_7day,                // mm cumulative saturation
            code: current.weather_code,
            temp_max: daily.temperature_2m_max[0]
        }; 
    } catch (e) {
        console.error("⚠️ Weather API Error:", e.message);
        return { rain_current: 0, rain_7day: 0, code: 0, temp_max: 30 }; 
    }
};

const fetchSoil = async (lat, lon) => {
    try {
        // SoilGrids API
        const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lat=${lat}&lon=${lon}&property=bdod&property=clay&property=sand&property=silt&depth=0-5cm`;
        const response = await axios.get(url, { timeout: 5000 });
        const layers = response.data.properties.layers;
        
        const getVal = (name) => layers.find(l => l.name === name)?.depths[0]?.values['mean'];

        let clay = getVal('clay');
        let sand = getVal('sand');
        let bd = getVal('bdod'); // Bulk Density in cg/cm3

        // NULL handling (Urban areas/Roads)
        if (clay === null) {
            return { clay: 30, sand: 40, bulk_density: 150, type: "Urban/Unknown" };
        }

        return { 
            clay: clay / 10,   // Convert to %
            sand: sand / 10,   // Convert to %
            bulk_density: bd,  // cg/cm3 (e.g., 140 = 1.4 g/cm3)
            type: "Measured"
        };

    } catch (e) {
        // Fallback for Kerala if API fails
        console.log("⚠️ Soil API failed, using Kerala Laterite defaults");
        return { clay: 35, sand: 45, bulk_density: 145, type: "Default Laterite" };
    }
};

// ==========================================
// 3. PHYSICS ENGINE (Infinite Slope Model)
// ==========================================

const analyzeLandslideRisk = (lat, slopeObj, weather, soil, depth) => {
    const { slope } = slopeObj;
    const { rain_current, rain_7day } = weather;
    const { clay, sand, bulk_density } = soil;

    // --- A. KERALA CONTEXT DETECTION ---
    // Kerala Latitudes approx 8.0 to 13.0
    const isKerala = (lat >= 8 && lat <= 13);
    
    // --- B. UNIT CONVERSIONS ---
    const G = 9.81; // Gravity (m/s2)
    const GAMMA_WATER = 9.81; // Unit weight of water (kN/m3)
    
    // Failure Plane Depth (z) in meters
    // In Kerala, shallow landslides are typically 1.5m to 3.0m deep
    const z = depth || 2.0; 

    // Convert Slope to Radians
    const beta = slope * (Math.PI / 180);

    // --- C. SOIL PROPERTIES (TUNED) ---
    // Convert SoilGrids Bulk Density (140 cg/cm3) -> Unit Weight (kN/m3)
    // 140 cg/cm3 = 1400 kg/m3. 
    // Dry Unit Weight:
    let gamma_dry = (bulk_density * 10 * G) / 1000; // Result approx 13-16 kN/m3
    if (!gamma_dry || gamma_dry < 10) gamma_dry = 16.0; // Default for Laterite

    // Saturated Unit Weight (Added weight of water in pores)
    // Typical Porosity (n) for Laterite is 0.3 to 0.4
    const n = 0.35; 
    const gamma_sat = ((gamma_dry) + (n * GAMMA_WATER));

    // Friction Angle (Phi) & Cohesion (c)
    let phi, c_base;

    if (isKerala) {
        // KERALA LATERITE MODEL
        // Dry Laterite is very strong (cemented). Wet Laterite loses cohesion.
        // We use "Effective Strength" parameters for wet conditions.
        phi = 30 + (sand * 0.1);    // High friction (30-34°)
        c_base = 5 + (clay * 0.2);  // Moderate cohesion (5-15 kPa)
    } else {
        // Generic Soil Model
        phi = 20 + (sand * 0.15);
        c_base = 2 + (clay * 0.3);
    }

    // --- D. HYDROLOGY (PORE PRESSURE) ---
    // Calculate 'm' (Water table height ratio, 0.0 to 1.0)
    // 1.0 = Water table is at surface (fully saturated)
    
    // Kerala thresholds: 
    // - 200mm in 7 days is high saturation.
    // - 30mm/hour intensity causes immediate surface saturation.
    
    let saturation_history = Math.min(rain_7day / 250, 0.8); // Base saturation from past rain
    let saturation_burst = Math.min(rain_current / 40, 0.5); // Immediate saturation from current storm
    
    let m = saturation_history + saturation_burst;
    if (m > 1.0) m = 1.0; 
    if (m < 0) m = 0;

    // Use Saturated Unit Weight if wet, Dry if dry
    const gamma_soil = m > 0.2 ? gamma_sat : gamma_dry;

    // Root Cohesion (Vegetation)
    // In Kerala, rubber plantations (common) have shallow roots (Low cohesion). 
    // Forests have high cohesion. We'll assume moderate (3 kPa) as safety baseline.
    const root_c = 3.0; 
    const c_total = c_base + root_c;

    // --- E. STABILITY CALCULATIONS ---
    
    // 1. Driving Stress (Shear Stress causing slide)
    // τ = γ * z * sin(β) * cos(β)
    const tau_driving = gamma_soil * z * Math.sin(beta) * Math.cos(beta);

    // 2. Pore Water Pressure (u)
    // u = γ_w * m * z * cos²(β)
    const u = GAMMA_WATER * m * z * Math.pow(Math.cos(beta), 2);

    // 3. Effective Normal Stress (σ')
    // σ' = (γ * z * cos²(β)) - u
    const sigma_n = gamma_soil * z * Math.pow(Math.cos(beta), 2);
    const sigma_effective = Math.max(0, sigma_n - u);

    // 4. Resisting Strength (Shear Strength holding it back)
    // τ_r = c' + σ' * tan(φ)
    const tan_phi = Math.tan(phi * (Math.PI / 180));
    const tau_resisting = c_total + (sigma_effective * tan_phi);

    // 5. Factor of Safety (FoS)
    let FoS = 0;
    if (slope < 5) {
        FoS = 100; // Flat land is safe
    } else if (tau_driving <= 0.01) {
        FoS = 100;
    } else {
        FoS = tau_resisting / tau_driving;
    }

    // --- F. RISK CLASSIFICATION ---
    let level = "Low";
    let probability = 0;

    if (FoS < 1.0) {
        level = "Extreme"; // Failure condition
        probability = 95;
    } else if (FoS < 1.25) {
        level = "High";    // Critical condition
        probability = 75;
    } else if (FoS < 1.5) {
        level = "Medium";  // Warning condition
        probability = 40;
    } else {
        level = "Low";
        probability = 5;
    }

    // --- OUTPUT ---
    return {
        level,
        soil_name: isKerala ? "Kerala Lateritic Soil" : "Generic Soil",
        physics: {
            FoS: parseFloat(FoS.toFixed(2)),
            probability,
            slope_angle: slope,
            shear_stress_driving: parseFloat(tau_driving.toFixed(2)), // kPa
            shear_strength_resisting: parseFloat(tau_resisting.toFixed(2)), // kPa
            pore_pressure: parseFloat(u.toFixed(2)), // kPa
            saturation_m: parseFloat(m.toFixed(2)), // 0.0 - 1.0
            cohesion: parseFloat(c_total.toFixed(1)), // kPa
            friction_angle: parseFloat(phi.toFixed(1)), // Degrees
            unit_weight: parseFloat(gamma_soil.toFixed(1)) // kN/m3
        }
    };
};

// ==========================================
// 4. API ENDPOINT
// ==========================================

app.post('/predict', async (req, res) => {
    const { lat, lng, manualRain, depth } = req.body;
    
    console.log(`\n📍 Request: ${lat}, ${lng} (Kerala Mode: ${lat >= 8 && lat <= 13})`);

    try {
        // 1. Parallel Data Fetching
        const [weather, soil, topo] = await Promise.all([
            fetchWeather(lat, lng),
            fetchSoil(lat, lng),
            calculateSlope(lat, lng)
        ]);

        // 2. Simulation Overrides
        if (manualRain !== undefined && manualRain !== null) {
            console.log(`🔧 Simulation Mode: Rain = ${manualRain}mm`);
            weather.rain_current = manualRain;
            weather.rain_7day = manualRain * 5; // Simulating a wet week
        }

        // 3. Analysis
        const analysis = analyzeLandslideRisk(lat, topo, weather, soil, depth);

        // 4. Construct Response
        const response = {
            location: { lat, lng, elevation: topo.elevation },
            environment: {
                rain_intensity: weather.rain_current + " mm/hr",
                rain_cumulative: weather.rain_7day.toFixed(0) + " mm (7-day)",
                soil_texture: `${soil.clay.toFixed(0)}% Clay, ${soil.sand.toFixed(0)}% Sand`,
                slope_aspect: topo.aspect + "°"
            },
            prediction: {
                risk_level: analysis.level,
                probability: analysis.physics.probability,
                summary: `FoS: ${analysis.physics.FoS} | ${analysis.level} Risk`,
                details: analysis.physics
            }
        };

        console.log(`✅ Result: ${analysis.level} (FoS: ${analysis.physics.FoS})`);
        res.json(response);

    } catch (error) {
        console.error("❌ System Error:", error);
        res.status(500).json({ error: "Calculation failed", details: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Kerala Landslide Engine Running on Port ${PORT}`);
});
