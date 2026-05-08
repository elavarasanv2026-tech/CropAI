const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fsModule = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const dotenvPath = path.join(__dirname, '.env');
const frontendDir = path.join(__dirname, '..', 'frontend');
const dotenvResult = dotenv.config({ path: dotenvPath });
if (dotenvResult.error) {
    console.error(`[ENV] Failed to load .env from ${dotenvPath}:`, dotenvResult.error.message);
} else {
    console.log(`[ENV] Loaded .env from ${dotenvPath}`);
    console.log('[ENV] Restart the server after changing .env so updated API keys are reloaded.');
}
const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');
const scrapeVegetablePrices = require('./scrape_prices');
const emailVerificationAuthRoutes = require('./routes/auth');
const {
    externalApiConfig,
    mapExternalApiError,
    requestCropHealthIdentification,
    requestPlantIdIdentification
} = require('./services/kindwiseClient');
const UserStore = require('./database');
const jsonDb = new UserStore('farmers.json');
let User = require('./models/User');

// Helper to ensure mock users look like Mongoose documents
const beautifyMockUser = (user) => {
    if (!user) return null;
    if (!user._id && user.id) user._id = user.id;
    if (!user.id && user._id) user.id = user._id;
    user.save = async function() { 
        const result = await jsonDb.updateUser(this.id || this._id, this);
        return beautifyMockUser(result);
    };
    return user;
};

// Mock User model to mimic Mongoose for JSON fallback
const MockUser = {
    findOne: async (query) => {
        const users = jsonDb.data.users || [];
        let user = null;
        if (query.email) user = users.find(u => String(u.email).toLowerCase() === String(query.email).toLowerCase());
        else if (query.username) user = users.find(u => String(u.username).toLowerCase() === String(query.username).toLowerCase());
        else if (query.verificationToken) user = users.find(u => u.verificationToken === query.verificationToken);
        else if (query.$or) {
            user = users.find(u => query.$or.some(q => {
                if (q.email) return String(u.email).toLowerCase() === String(q.email).toLowerCase();
                if (q.username) return String(u.username).toLowerCase() === String(q.username).toLowerCase();
                return false;
            }));
        }
        return beautifyMockUser(user);
    },
    findById: async (id) => {
        return beautifyMockUser(jsonDb.findUserById(id));
    },
    findByIdAndUpdate: async (id, updates) => {
        const result = await jsonDb.updateUser(id, updates);
        return beautifyMockUser(result);
    },
    create: async (data) => {
        const user = jsonDb.createUser(data);
        return beautifyMockUser(user);
    }
};

// Prototype for 'new User' that works with our fallback
function UserInstance(data) {
    Object.assign(this, data);
    this.save = async function() {
        const existing = jsonDb.findUserByEmail(this.email);
        let user;
        if (existing) {
            user = await jsonDb.updateUser(existing.id || existing._id, this);
        } else {
            user = await jsonDb.createUser(this);
        }
        Object.assign(this, user);
        return beautifyMockUser(this);
    };
}


let marketDataCache = {
    data: null,
    lastUpdate: 0,
    requestedDate: 'today'
};

let isMongoConnected = false;
let isUsingJsonFallback = false;
async function connectMongoDB() {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cropai';
    try {
        await mongoose.connect(mongoUri, {
            serverSelectionTimeoutMS: 5000 
        });
        isMongoConnected = true;
        isUsingJsonFallback = false;
        console.log('MongoDB connected successfully');
    } catch (error) {
        isMongoConnected = false;
        isUsingJsonFallback = true;
        console.warn('MongoDB unavailable, using JSON database fallback (farmers.json):', error.message);
        
        // Override User model with Mock for transparent fallback
        const OriginalUser = User;
        User = function(data) { return new UserInstance(data); };
        Object.assign(User, MockUser); 
        console.log('ℹ️  Application is now running in JSON Fallback Mode.');
    }
}

async function findUserByVerificationToken(token) {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) return null;

    let user = await User.findOne({ verificationToken: normalizedToken });
    if (user) return user;

    const fallbackUser = (jsonDb.data.users || []).find(
        entry => String(entry.verificationToken || '').trim() === normalizedToken
    );
    return beautifyMockUser(fallbackUser);
}

function normalizeVegetableName(name) {
    return String(name || '').trim().toLowerCase();
}

function applyVegetableTrends(currentRows, previousRows = []) {
    const previousByName = new Map(
        previousRows.map(row => [normalizeVegetableName(row.name), row])
    );

    return currentRows.map(row => {
        const previous = previousByName.get(normalizeVegetableName(row.name));
        const previousPrice = previous ? Number(previous.price) : null;
        const price = Number(row.price) || 0;

        let trend = 'stable';
        let priceChange = 0;

        if (previousPrice !== null && !Number.isNaN(previousPrice)) {
            priceChange = price - previousPrice;
            if (priceChange > 0) trend = 'up';
            else if (priceChange < 0) trend = 'down';
        }

        return {
            ...row,
            trend,
            priceChange
        };
    });
}

function pickTopMover(rows, direction = 'up') {
    const sorted = [...rows].sort((a, b) => {
        const aChange = Number(a.priceChange || 0);
        const bChange = Number(b.priceChange || 0);
        return direction === 'up' ? bChange - aChange : aChange - bChange;
    });

    const mover = sorted.find(row => direction === 'up' ? row.priceChange > 0 : row.priceChange < 0);
    if (mover) return mover;

    return direction === 'up'
        ? [...rows].sort((a, b) => Number(b.price) - Number(a.price))[0]
        : [...rows].sort((a, b) => Number(a.price) - Number(b.price))[0];
}

function buildDateVariantRows(baseRows, requestedDate) {
    const dateText = String(requestedDate || 'today');
    let seed = 0;
    for (let i = 0; i < dateText.length; i++) {
        seed = (seed * 31 + dateText.charCodeAt(i)) >>> 0;
    }

    return baseRows.map((row, index) => {
        const price = Number(row.price || 0);
        const spread = Math.max(1, Math.round(price * 0.08));
        const swing = ((seed + index * 17) % (spread * 2 + 1)) - spread;
        const adjustedPrice = Math.max(1, price + swing);
        const retailMin = Math.max(1, Math.round(adjustedPrice * 1.2));
        const retailMax = Math.max(retailMin, Math.round(adjustedPrice * 1.45));
        const priceChange = adjustedPrice - price;

        return {
            ...row,
            price: adjustedPrice,
            retailPrice: `₹${retailMin} - ${retailMax}`,
            retailMin,
            retailMax,
            trend: priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : 'stable',
            priceChange
        };
    });
}

function formatDateLabel(dateValue) {
    if (!dateValue || dateValue === 'today') return 'Today';
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return String(dateValue);
    const day = String(date.getDate()).padStart(2, '0');
    const month = date.toLocaleString('en-US', { month: 'short' });
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

const cropDatasetPath = path.join(__dirname, 'Crop Recommendation datasets', 'Crop_recommendation.csv');
const cropFeatureKeys = ['N', 'P', 'K', 'temperature', 'humidity', 'ph', 'rainfall'];
let cropRecommendationDataset = [];
let cropDatasetRanges = {};
let cropDatasetProfiles = {};
const MIN_RECOMMENDATION_RESULTS = 20;
const MAX_RECOMMENDATION_RESULTS = 25;

function toTitleCase(value) {
    return String(value || '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, ch => ch.toUpperCase());
}

function beautifyCropLabel(label) {
    const normalized = String(label || '').trim().toLowerCase();
    const special = {
        blackgram: 'Black Gram',
        chickpea: 'Chickpea',
        kidneybeans: 'Kidney Beans',
        mothbeans: 'Moth Beans',
        mungbean: 'Mung Bean',
        muskmelon: 'Muskmelon',
        pigeonpeas: 'Pigeon Peas'
    };
    return special[normalized] || toTitleCase(normalized);
}

function parseCsvLine(line) {
    return String(line || '').split(',').map(part => part.trim());
}

function loadCropRecommendationDataset() {
    try {
        if (!fsModule.existsSync(cropDatasetPath)) {
            console.warn(`[DATASET] Crop dataset not found at ${cropDatasetPath}`);
            return;
        }

        const raw = fsModule.readFileSync(cropDatasetPath, 'utf8').trim();
        const lines = raw.split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) return;

        const headers = parseCsvLine(lines[0]);
        const rows = [];
        const ranges = {};
        const cropBuckets = {};

        cropFeatureKeys.forEach((key) => {
            ranges[key] = { min: Infinity, max: -Infinity };
        });

        for (const line of lines.slice(1)) {
            const parts = parseCsvLine(line);
            if (parts.length !== headers.length) continue;

            const row = {};
            headers.forEach((header, index) => {
                row[header] = header === 'label' ? parts[index] : Number(parts[index]);
            });

            if (!row.label || cropFeatureKeys.some((key) => !Number.isFinite(row[key]))) continue;
            rows.push(row);

            cropFeatureKeys.forEach((key) => {
                ranges[key].min = Math.min(ranges[key].min, row[key]);
                ranges[key].max = Math.max(ranges[key].max, row[key]);
            });

            const label = row.label;
            if (!cropBuckets[label]) {
                cropBuckets[label] = { count: 0 };
                cropFeatureKeys.forEach((key) => {
                    cropBuckets[label][`${key}Sum`] = 0;
                    cropBuckets[label][`${key}Min`] = Infinity;
                    cropBuckets[label][`${key}Max`] = -Infinity;
                });
            }

            cropBuckets[label].count += 1;
            cropFeatureKeys.forEach((key) => {
                cropBuckets[label][`${key}Sum`] += row[key];
                cropBuckets[label][`${key}Min`] = Math.min(cropBuckets[label][`${key}Min`], row[key]);
                cropBuckets[label][`${key}Max`] = Math.max(cropBuckets[label][`${key}Max`], row[key]);
            });
        }

        const profiles = {};
        Object.entries(cropBuckets).forEach(([label, bucket]) => {
            profiles[label] = { count: bucket.count };
            cropFeatureKeys.forEach((key) => {
                profiles[label][key] = bucket[`${key}Sum`] / bucket.count;
                profiles[label][`${key}Min`] = bucket[`${key}Min`];
                profiles[label][`${key}Max`] = bucket[`${key}Max`];
            });
        });

        cropRecommendationDataset = rows;
        cropDatasetRanges = ranges;
        cropDatasetProfiles = profiles;
        console.log(`[DATASET] Loaded ${rows.length} crop recommendation rows across ${Object.keys(profiles).length} crops.`);
    } catch (error) {
        console.error('[DATASET] Failed to load crop recommendation dataset:', error.message);
    }
}

loadCropRecommendationDataset();

function inferDatasetSoilType(avgPh, requestedSoilType) {
    const requested = String(requestedSoilType || '').trim();
    if (requested) return requested;
    if (avgPh < 5.8) return 'Acidic loam';
    if (avgPh > 7.5) return 'Alkaline alluvial soil';
    return 'Loamy to well-drained soil';
}

function inferWaterLevel(avgRainfall, avgHumidity, requestedWaterAvailability) {
    const requested = String(requestedWaterAvailability || '').trim();
    if (requested) return toTitleCase(requested);
    const score = avgRainfall + (avgHumidity * 1.5);
    if (score >= 220) return 'High';
    if (score >= 140) return 'Medium';
    return 'Low';
}

function inferYieldUnit(crop) {
    const name = String(crop || '').toLowerCase();
    if (['banana', 'coconut', 'papaya', 'mango', 'watermelon', 'muskmelon', 'orange', 'apple', 'grapes'].some(term => name.includes(term))) {
        return 'tons/acre';
    }
    if (['coffee'].some(term => name.includes(term))) return 'kg/acre';
    return 'q/acre';
}

function inferCropSeason(avgTemp, avgRainfall, season) {
    if (season) return toTitleCase(season);
    if (avgRainfall >= 150) return 'Monsoon';
    if (avgTemp <= 22) return 'Winter';
    if (avgTemp >= 30) return 'Summer';
    return 'Spring';
}

function buildDatasetRecommendations(input) {
    if (!cropRecommendationDataset.length) return null;

    const numericInput = {
        N: Number(input.n),
        P: Number(input.p),
        K: Number(input.k),
        temperature: Number(input.temperature),
        humidity: Number(input.humidity),
        ph: Number(input.ph),
        rainfall: Number(input.rainfall)
    };

    const normalizedDistance = (row) => {
        return cropFeatureKeys.reduce((sum, key) => {
            const range = Math.max(1, (cropDatasetRanges[key]?.max || 0) - (cropDatasetRanges[key]?.min || 0));
            return sum + Math.abs(row[key] - numericInput[key]) / range;
        }, 0);
    };

    const topMatches = cropRecommendationDataset
        .map((row) => ({ ...row, distance: normalizedDistance(row) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 120);

    const grouped = {};
    for (const row of topMatches) {
        if (!grouped[row.label]) grouped[row.label] = [];
        grouped[row.label].push(row);
    }

    const results = Object.entries(grouped).map(([label, matches]) => {
        const profile = cropDatasetProfiles[label] || {};
        const avgDistance = matches.reduce((sum, item) => sum + item.distance, 0) / matches.length;
        const bestDistance = matches[0]?.distance ?? avgDistance;
        const closeness = Math.max(0, 1 - ((avgDistance * 0.55) + (bestDistance * 0.45)));
        let suitabilityScore = Math.round(55 + closeness * 44);

        const crop = beautifyCropLabel(label);
        const avgTemp = profile.temperature ?? numericInput.temperature;
        const avgHumidity = profile.humidity ?? numericInput.humidity;
        const avgPh = profile.ph ?? numericInput.ph;
        const avgRainfall = profile.rainfall ?? numericInput.rainfall;

        if (String(input.climate || '').toLowerCase().includes('arid') && avgRainfall < 120) suitabilityScore += 3;
        if (String(input.climate || '').toLowerCase().includes('tropical') && avgTemp > 24) suitabilityScore += 3;
        if (String(input.season || '').toLowerCase().includes('monsoon') && avgRainfall > 140) suitabilityScore += 4;
        if (String(input.waterAvailability || '').toLowerCase() === 'low' && avgRainfall < 110) suitabilityScore += 4;
        suitabilityScore = Math.max(45, Math.min(98, suitabilityScore));

        const yieldBase = Math.max(2, suitabilityScore / 8);
        const yieldUnit = inferYieldUnit(crop);
        const yieldRange = yieldUnit === 'tons/acre'
            ? `${Math.max(2, Math.round(yieldBase))}-${Math.max(4, Math.round(yieldBase + 3))}`
            : yieldUnit === 'kg/acre'
                ? `${Math.max(400, Math.round(yieldBase * 120))}-${Math.max(700, Math.round((yieldBase + 2) * 120))}`
                : `${Math.max(6, Math.round(yieldBase))}-${Math.max(10, Math.round(yieldBase + 4))}`;

        const marketValueNumber = Math.round((suitabilityScore * 1800) + ((Number(input.farmSize) || 1) * 12000));
        const profitMargin = `${Math.max(110, Math.round(115 + (suitabilityScore - 50) * 2.2))}%`;
        const sustainabilityScore = Math.max(68, Math.min(96, Math.round(72 + (100 - Math.abs(6.8 - avgPh) * 12) / 3)));
        const waterLevel = inferWaterLevel(avgRainfall, avgHumidity, input.waterAvailability);
        const plantingSeason = inferCropSeason(avgTemp, avgRainfall, input.season);
        const harvestingSeason = plantingSeason === 'Monsoon'
            ? 'Post-Monsoon'
            : plantingSeason === 'Winter'
                ? 'Late Winter / Early Spring'
                : plantingSeason === 'Summer'
                    ? 'Late Summer / Early Autumn'
                    : 'Next 90-120 days';

        return {
            crop,
            suitabilityScore,
            suitability: suitabilityScore >= 90 ? 'Excellent' : suitabilityScore >= 80 ? 'High' : suitabilityScore >= 70 ? 'Moderate' : 'Low',
            description: `${crop} closely matches the dataset profile for your current NPK balance, rainfall, temperature, humidity, and pH. Similar records in the training data perform best around ${avgTemp.toFixed(1)}°C, ${avgHumidity.toFixed(0)}% humidity, and pH ${avgPh.toFixed(1)}, making it a strong fit for this farm setup.`,
            conditionSummary: `Dataset match strong, pH ${avgPh.toFixed(1)} suitable, rainfall and humidity aligned`,
            climateDetails: {
                tempRange: `${Math.round((profile.temperatureMin ?? avgTemp) - 1)}-${Math.round((profile.temperatureMax ?? avgTemp) + 1)}°C`,
                humidity: `${Math.round(profile.humidityMin ?? avgHumidity)}-${Math.round(profile.humidityMax ?? avgHumidity)}%`
            },
            soilDetails: {
                ph: `${(profile.phMin ?? avgPh).toFixed(1)}-${(profile.phMax ?? avgPh).toFixed(1)}`,
                moisture: waterLevel,
                type: inferDatasetSoilType(avgPh, input.soilType)
            },
            waterRequirements: {
                level: waterLevel,
                advice: waterLevel === 'High'
                    ? 'Maintain consistent moisture and avoid long dry spells during active growth.'
                    : waterLevel === 'Medium'
                        ? 'Use regular irrigation with good drainage to keep soil evenly moist.'
                        : 'Prefer drip irrigation and avoid overwatering; this crop handles leaner water conditions better.'
            },
            yieldRange,
            yieldUnit,
            marketValue: `₹${marketValueNumber.toLocaleString('en-IN')}`,
            profitMargin,
            sustainabilityScore,
            plantingSeason,
            harvestingSeason,
            imageKeyword: `${crop} crop farming field`,
            recommendationReason: `Matched against ${matches.length} close dataset records for ${crop}.`
        };
    });

    const recommendations = results
        .sort((a, b) => b.suitabilityScore - a.suitabilityScore)
        .slice(0, 5);

    return {
        source: 'Dataset-Driven Crop Recommendation Engine',
        analysisSummary: `Recommendations were matched directly against the crop dataset using N, P, K, temperature, humidity, pH, and rainfall, then aligned with your farm setup (${toTitleCase(input.soilType)}, ${toTitleCase(input.climate)}, ${toTitleCase(input.season)}).`,
        recommendations
    };
}

const dynamicCropCatalogPath = path.join(__dirname, 'Crop Recommendation datasets', 'dynamic_crop_catalog.json');
const dynamicCropCatalogBackupDir = path.join(__dirname, 'Crop Recommendation datasets', 'backups');
const dynamicCropCatalogBackupPath = path.join(dynamicCropCatalogBackupDir, 'dynamic_crop_catalog.backup.json');

let dynamicCropRecommendationCatalog = {
    apple: { soils: ['loam', 'sandy loam', 'well drained'], climates: ['temperate', 'cool'], seasons: ['winter', 'rabi'], water: 'medium', temp: [16, 24], rain: [100, 150], humidity: [55, 75], ph: [5.8, 6.8], N: [70, 120], P: [35, 70], K: [120, 200], yield: [6, 10], yieldUnit: 'tons/acre', baseIncome: 240000, baseMargin: 180, sustainability: 78, plantingSeason: 'December-January', harvestingSeason: 'August-October', imageKeyword: 'apple orchard farm' },
    banana: { soils: ['loam', 'alluvial', 'clay loam'], climates: ['tropical', 'humid'], seasons: ['monsoon', 'kharif', 'summer'], water: 'high', temp: [24, 34], rain: [120, 250], humidity: [70, 90], ph: [6.0, 7.5], N: [90, 150], P: [40, 80], K: [150, 260], yield: [14, 22], yieldUnit: 'tons/acre', baseIncome: 280000, baseMargin: 220, sustainability: 72, plantingSeason: 'June-September', harvestingSeason: '11-13 months', imageKeyword: 'banana plantation farm' },
    blackgram: { soils: ['loam', 'clay loam', 'alluvial'], climates: ['tropical', 'subtropical'], seasons: ['kharif', 'monsoon', 'summer'], water: 'low', temp: [25, 35], rain: [60, 120], humidity: [45, 70], ph: [6.0, 7.8], N: [20, 70], P: [25, 60], K: [20, 60], yield: [4, 7], yieldUnit: 'q/acre', baseIncome: 70000, baseMargin: 145, sustainability: 88, plantingSeason: 'June-July', harvestingSeason: 'September-October', imageKeyword: 'black gram crop field' },
    chickpea: { soils: ['loam', 'sandy loam', 'black soil'], climates: ['cool', 'semi arid', 'subtropical'], seasons: ['winter', 'rabi'], water: 'low', temp: [18, 28], rain: [45, 90], humidity: [35, 60], ph: [6.0, 8.0], N: [20, 70], P: [25, 65], K: [20, 60], yield: [5, 9], yieldUnit: 'q/acre', baseIncome: 76000, baseMargin: 150, sustainability: 90, plantingSeason: 'October-November', harvestingSeason: 'February-March', imageKeyword: 'chickpea farm field' },
    coconut: { soils: ['coastal', 'alluvial', 'loam', 'sandy loam'], climates: ['tropical', 'humid'], seasons: ['monsoon', 'summer'], water: 'high', temp: [24, 33], rain: [130, 250], humidity: [70, 90], ph: [5.5, 7.5], N: [70, 130], P: [30, 70], K: [120, 220], yield: [4, 7], yieldUnit: 'tons/acre', baseIncome: 230000, baseMargin: 190, sustainability: 82, plantingSeason: 'June-September', harvestingSeason: 'Year-round', imageKeyword: 'coconut plantation farm' },
    coffee: { soils: ['loam', 'forest', 'well drained', 'acidic'], climates: ['tropical', 'humid', 'highland'], seasons: ['monsoon', 'winter'], water: 'medium', temp: [18, 28], rain: [120, 220], humidity: [60, 85], ph: [5.0, 6.5], N: [70, 120], P: [30, 60], K: [80, 140], yield: [550, 900], yieldUnit: 'kg/acre', baseIncome: 210000, baseMargin: 185, sustainability: 83, plantingSeason: 'June-August', harvestingSeason: 'November-February', imageKeyword: 'coffee plantation farm' },
    cotton: { soils: ['black soil', 'alluvial', 'loam'], climates: ['hot', 'tropical', 'semi arid'], seasons: ['kharif', 'summer', 'monsoon'], water: 'medium', temp: [22, 35], rain: [50, 120], humidity: [40, 65], ph: [5.8, 8.0], N: [70, 120], P: [30, 65], K: [40, 90], yield: [7, 12], yieldUnit: 'q/acre', baseIncome: 120000, baseMargin: 155, sustainability: 68, plantingSeason: 'May-June', harvestingSeason: 'October-December', imageKeyword: 'cotton crop field' },
    grapes: { soils: ['loam', 'sandy loam', 'well drained'], climates: ['warm', 'subtropical', 'semi arid'], seasons: ['winter', 'summer'], water: 'medium', temp: [20, 32], rain: [60, 110], humidity: [45, 65], ph: [6.0, 7.5], N: [65, 110], P: [30, 60], K: [120, 200], yield: [7, 11], yieldUnit: 'tons/acre', baseIncome: 260000, baseMargin: 205, sustainability: 76, plantingSeason: 'December-January', harvestingSeason: 'March-May', imageKeyword: 'grape vineyard farm' },
    jute: { soils: ['alluvial', 'clay loam', 'loam'], climates: ['humid', 'tropical', 'monsoon'], seasons: ['kharif', 'monsoon'], water: 'high', temp: [24, 34], rain: [140, 250], humidity: [70, 90], ph: [6.0, 7.5], N: [60, 110], P: [25, 55], K: [35, 75], yield: [8, 12], yieldUnit: 'q/acre', baseIncome: 90000, baseMargin: 150, sustainability: 84, plantingSeason: 'March-May', harvestingSeason: 'July-September', imageKeyword: 'jute crop field' },
    kidneybeans: { soils: ['loam', 'silt loam', 'well drained'], climates: ['cool', 'temperate', 'subtropical'], seasons: ['winter', 'rabi'], water: 'medium', temp: [18, 27], rain: [60, 110], humidity: [45, 65], ph: [6.0, 7.3], N: [20, 70], P: [25, 60], K: [25, 60], yield: [4, 7], yieldUnit: 'q/acre', baseIncome: 82000, baseMargin: 150, sustainability: 87, plantingSeason: 'October-November', harvestingSeason: 'January-February', imageKeyword: 'kidney beans crop field' },
    lentil: { soils: ['loam', 'clay loam', 'alluvial'], climates: ['cool', 'dry', 'subtropical'], seasons: ['winter', 'rabi'], water: 'low', temp: [18, 27], rain: [35, 80], humidity: [35, 60], ph: [6.0, 8.0], N: [20, 60], P: [25, 60], K: [20, 55], yield: [4, 6], yieldUnit: 'q/acre', baseIncome: 76000, baseMargin: 148, sustainability: 89, plantingSeason: 'October-November', harvestingSeason: 'February-March', imageKeyword: 'lentil crop field' },
    maize: { soils: ['loam', 'sandy loam', 'alluvial'], climates: ['tropical', 'subtropical', 'warm'], seasons: ['kharif', 'monsoon', 'summer'], water: 'medium', temp: [20, 32], rain: [60, 130], humidity: [50, 75], ph: [5.8, 7.5], N: [80, 140], P: [35, 70], K: [40, 85], yield: [18, 28], yieldUnit: 'q/acre', baseIncome: 95000, baseMargin: 145, sustainability: 79, plantingSeason: 'June-July', harvestingSeason: 'September-October', imageKeyword: 'maize crop field' },
    mango: { soils: ['loam', 'alluvial', 'well drained'], climates: ['tropical', 'subtropical', 'warm'], seasons: ['summer', 'monsoon'], water: 'medium', temp: [24, 35], rain: [75, 150], humidity: [50, 75], ph: [5.5, 7.5], N: [60, 110], P: [25, 55], K: [80, 150], yield: [5, 9], yieldUnit: 'tons/acre', baseIncome: 220000, baseMargin: 190, sustainability: 80, plantingSeason: 'July-September', harvestingSeason: 'April-June', imageKeyword: 'mango orchard farm' },
    mothbeans: { soils: ['sandy', 'sandy loam', 'arid'], climates: ['arid', 'dry', 'semi arid'], seasons: ['kharif', 'summer'], water: 'low', temp: [24, 36], rain: [25, 70], humidity: [25, 55], ph: [6.0, 8.5], N: [15, 55], P: [20, 50], K: [15, 50], yield: [3, 5], yieldUnit: 'q/acre', baseIncome: 68000, baseMargin: 152, sustainability: 93, plantingSeason: 'June-July', harvestingSeason: 'September-October', imageKeyword: 'moth beans crop field' },
    mungbean: { soils: ['loam', 'sandy loam', 'alluvial'], climates: ['warm', 'subtropical', 'tropical'], seasons: ['summer', 'kharif', 'monsoon'], water: 'low', temp: [24, 34], rain: [40, 100], humidity: [40, 65], ph: [6.0, 7.5], N: [20, 65], P: [20, 55], K: [20, 55], yield: [4, 7], yieldUnit: 'q/acre', baseIncome: 72000, baseMargin: 150, sustainability: 90, plantingSeason: 'June-July', harvestingSeason: 'September-October', imageKeyword: 'mung bean crop field' },
    muskmelon: { soils: ['sandy loam', 'loam', 'well drained'], climates: ['warm', 'dry', 'semi arid'], seasons: ['summer'], water: 'medium', temp: [24, 34], rain: [40, 90], humidity: [35, 60], ph: [6.0, 7.5], N: [55, 100], P: [25, 60], K: [70, 130], yield: [7, 11], yieldUnit: 'tons/acre', baseIncome: 170000, baseMargin: 175, sustainability: 74, plantingSeason: 'January-March', harvestingSeason: 'April-June', imageKeyword: 'muskmelon farm field' },
    orange: { soils: ['loam', 'alluvial', 'well drained'], climates: ['subtropical', 'warm', 'humid'], seasons: ['winter', 'monsoon'], water: 'medium', temp: [18, 32], rain: [80, 170], humidity: [50, 75], ph: [5.5, 7.5], N: [60, 110], P: [25, 55], K: [80, 140], yield: [6, 10], yieldUnit: 'tons/acre', baseIncome: 210000, baseMargin: 185, sustainability: 79, plantingSeason: 'July-September', harvestingSeason: 'November-February', imageKeyword: 'orange orchard farm' },
    papaya: { soils: ['loam', 'alluvial', 'well drained'], climates: ['tropical', 'humid', 'warm'], seasons: ['summer', 'monsoon'], water: 'medium', temp: [22, 34], rain: [90, 180], humidity: [55, 80], ph: [5.8, 7.2], N: [70, 120], P: [30, 60], K: [100, 170], yield: [10, 16], yieldUnit: 'tons/acre', baseIncome: 200000, baseMargin: 185, sustainability: 78, plantingSeason: 'June-September', harvestingSeason: '8-10 months', imageKeyword: 'papaya farm plantation' },
    pigeonpeas: { soils: ['loam', 'black soil', 'well drained'], climates: ['semi arid', 'subtropical', 'warm'], seasons: ['kharif', 'monsoon'], water: 'low', temp: [22, 34], rain: [50, 110], humidity: [35, 65], ph: [5.5, 7.8], N: [20, 65], P: [25, 60], K: [20, 60], yield: [5, 8], yieldUnit: 'q/acre', baseIncome: 78000, baseMargin: 152, sustainability: 91, plantingSeason: 'June-July', harvestingSeason: 'December-January', imageKeyword: 'pigeon pea crop field' },
    pomegranate: { soils: ['sandy loam', 'loam', 'alluvial'], climates: ['arid', 'dry', 'semi arid', 'warm'], seasons: ['summer', 'monsoon'], water: 'low', temp: [22, 35], rain: [30, 90], humidity: [25, 55], ph: [6.0, 7.8], N: [55, 95], P: [25, 55], K: [80, 150], yield: [5, 8], yieldUnit: 'tons/acre', baseIncome: 260000, baseMargin: 230, sustainability: 90, plantingSeason: 'June-August', harvestingSeason: 'December-February', imageKeyword: 'pomegranate orchard farm' },
    rice: { soils: ['clay', 'clay loam', 'alluvial', 'loam'], climates: ['humid', 'tropical', 'monsoon'], seasons: ['kharif', 'monsoon'], water: 'high', temp: [22, 35], rain: [120, 250], humidity: [70, 90], ph: [5.5, 7.2], N: [80, 140], P: [30, 70], K: [30, 70], yield: [18, 28], yieldUnit: 'q/acre', baseIncome: 105000, baseMargin: 150, sustainability: 83, plantingSeason: 'June-July', harvestingSeason: 'October-November', imageKeyword: 'rice paddy field' },
    watermelon: { soils: ['sandy loam', 'alluvial', 'well drained'], climates: ['hot', 'dry', 'warm'], seasons: ['summer'], water: 'medium', temp: [24, 36], rain: [40, 90], humidity: [35, 60], ph: [6.0, 7.5], N: [60, 110], P: [30, 60], K: [90, 160], yield: [8, 14], yieldUnit: 'tons/acre', baseIncome: 180000, baseMargin: 180, sustainability: 73, plantingSeason: 'January-March', harvestingSeason: 'April-June', imageKeyword: 'watermelon farm field' },
    ragi: { displayName: 'Ragi', category: 'food crop', soils: ['red soil', 'laterite', 'loam'], climates: ['dry', 'semi arid', 'warm'], seasons: ['kharif', 'monsoon'], water: 'low', moisture: [25, 45], temp: [22, 32], rain: [50, 110], humidity: [35, 60], ph: [5.0, 7.5], N: [25, 65], P: [20, 50], K: [20, 55], yield: [7, 11], yieldUnit: 'q/acre', baseIncome: 76000, baseMargin: 152, sustainability: 95, plantingSeason: 'June-July', harvestingSeason: 'October-November', imageKeyword: 'ragi crop field', regions: ['Dharmapuri', 'Krishnagiri', 'Salem'] },
    pearlmillet: { displayName: 'Cumbu / Pearl Millet', category: 'food crop', soils: ['sandy', 'sandy loam', 'red soil'], climates: ['dry', 'semi arid', 'hot'], seasons: ['kharif', 'summer'], water: 'low', moisture: [20, 40], temp: [24, 38], rain: [30, 80], humidity: [25, 50], ph: [6.0, 8.5], N: [20, 55], P: [15, 45], K: [15, 45], yield: [6, 10], yieldUnit: 'q/acre', baseIncome: 70000, baseMargin: 150, sustainability: 96, plantingSeason: 'June-July', harvestingSeason: 'September-October', imageKeyword: 'pearl millet crop field', regions: ['Ramanathapuram', 'Virudhunagar', 'Thoothukudi'] },
    foxtailmillet: { displayName: 'Thinai', category: 'food crop', soils: ['red soil', 'sandy loam', 'loam'], climates: ['dry', 'warm', 'semi arid'], seasons: ['kharif', 'summer'], water: 'low', moisture: [20, 45], temp: [22, 34], rain: [40, 90], humidity: [30, 55], ph: [5.5, 7.5], N: [20, 55], P: [18, 45], K: [18, 45], yield: [5, 8], yieldUnit: 'q/acre', baseIncome: 72000, baseMargin: 155, sustainability: 95, plantingSeason: 'June-July', harvestingSeason: 'September-October', imageKeyword: 'foxtail millet farm field' },
    littlemillet: { displayName: 'Samai', category: 'food crop', soils: ['red soil', 'loam', 'laterite'], climates: ['warm', 'semi arid'], seasons: ['kharif', 'monsoon'], water: 'low', moisture: [25, 45], temp: [22, 32], rain: [50, 100], humidity: [35, 60], ph: [5.5, 7.5], N: [20, 55], P: [18, 45], K: [18, 45], yield: [5, 8], yieldUnit: 'q/acre', baseIncome: 72000, baseMargin: 154, sustainability: 94, plantingSeason: 'June-July', harvestingSeason: 'September-October', imageKeyword: 'little millet farm field' },
    kodomillet: { displayName: 'Varagu', category: 'food crop', soils: ['red soil', 'gravelly loam', 'laterite'], climates: ['dry', 'semi arid'], seasons: ['kharif'], water: 'low', moisture: [20, 40], temp: [22, 34], rain: [45, 95], humidity: [30, 55], ph: [5.5, 7.5], N: [20, 55], P: [18, 45], K: [18, 45], yield: [5, 8], yieldUnit: 'q/acre', baseIncome: 71000, baseMargin: 154, sustainability: 94, plantingSeason: 'June-July', harvestingSeason: 'October-November', imageKeyword: 'kodo millet farm field' },
    sorghum: { displayName: 'Cholam / Sorghum', category: 'food crop', soils: ['black soil', 'loam', 'red soil'], climates: ['dry', 'semi arid', 'hot'], seasons: ['kharif', 'summer', 'rabi'], water: 'low', moisture: [20, 45], temp: [24, 36], rain: [40, 100], humidity: [25, 55], ph: [6.0, 8.0], N: [25, 65], P: [20, 50], K: [20, 50], yield: [8, 13], yieldUnit: 'q/acre', baseIncome: 76000, baseMargin: 150, sustainability: 93, plantingSeason: 'June-July', harvestingSeason: 'October-November', imageKeyword: 'sorghum crop field', regions: ['Erode', 'Namakkal', 'Karur'] },
    wheat: { displayName: 'Wheat', category: 'food crop', soils: ['alluvial', 'loam', 'clay loam'], climates: ['cool', 'temperate'], seasons: ['winter', 'rabi'], water: 'medium', moisture: [35, 60], temp: [15, 25], rain: [50, 100], humidity: [40, 65], ph: [6.0, 7.8], N: [60, 110], P: [30, 60], K: [30, 60], yield: [10, 16], yieldUnit: 'q/acre', baseIncome: 86000, baseMargin: 145, sustainability: 76, plantingSeason: 'October-November', harvestingSeason: 'February-March', imageKeyword: 'wheat crop field', regions: ['The Nilgiris', 'Dindigul'] },
    cowpea: { displayName: 'Cowpea', category: 'pulse', soils: ['sandy loam', 'loam', 'red soil'], climates: ['warm', 'semi arid', 'tropical'], seasons: ['kharif', 'summer'], water: 'low', moisture: [20, 45], temp: [22, 34], rain: [40, 90], humidity: [30, 60], ph: [5.5, 7.5], N: [20, 55], P: [20, 50], K: [20, 50], yield: [4, 7], yieldUnit: 'q/acre', baseIncome: 69000, baseMargin: 150, sustainability: 91, plantingSeason: 'June-July', harvestingSeason: 'September-October', imageKeyword: 'cowpea crop field' },
    horsegram: { displayName: 'Horse Gram', category: 'pulse', soils: ['red soil', 'laterite', 'gravelly'], climates: ['dry', 'semi arid'], seasons: ['kharif', 'rabi'], water: 'low', moisture: [18, 40], temp: [22, 34], rain: [30, 80], humidity: [25, 55], ph: [5.5, 7.5], N: [15, 45], P: [15, 40], K: [15, 40], yield: [3, 5], yieldUnit: 'q/acre', baseIncome: 66000, baseMargin: 152, sustainability: 96, plantingSeason: 'August-September', harvestingSeason: 'December-January', imageKeyword: 'horse gram crop field' },
    groundnut: { displayName: 'Groundnut', category: 'oilseed', soils: ['sandy loam', 'red soil', 'well drained'], climates: ['warm', 'semi arid', 'dry'], seasons: ['kharif', 'summer'], water: 'low', moisture: [20, 45], temp: [24, 34], rain: [45, 100], humidity: [30, 60], ph: [5.8, 7.5], N: [20, 55], P: [25, 60], K: [25, 60], yield: [7, 12], yieldUnit: 'q/acre', baseIncome: 92000, baseMargin: 162, sustainability: 88, plantingSeason: 'June-July', harvestingSeason: 'September-October', imageKeyword: 'groundnut crop field', regions: ['Villupuram', 'Cuddalore', 'Vellore'] },
    sesame: { displayName: 'Sesame', category: 'oilseed', soils: ['sandy loam', 'red soil', 'alluvial'], climates: ['warm', 'dry', 'semi arid'], seasons: ['summer', 'kharif'], water: 'low', moisture: [18, 40], temp: [24, 36], rain: [35, 85], humidity: [25, 50], ph: [5.5, 7.5], N: [20, 50], P: [20, 50], K: [20, 45], yield: [3, 5], yieldUnit: 'q/acre', baseIncome: 76000, baseMargin: 158, sustainability: 92, plantingSeason: 'February-March', harvestingSeason: 'May-June', imageKeyword: 'sesame crop field' },
    sunflower: { displayName: 'Sunflower', category: 'oilseed', soils: ['loam', 'black soil', 'alluvial'], climates: ['warm', 'dry', 'semi arid'], seasons: ['summer', 'rabi'], water: 'medium', moisture: [30, 55], temp: [20, 32], rain: [45, 90], humidity: [30, 55], ph: [6.0, 7.8], N: [45, 85], P: [25, 55], K: [30, 60], yield: [5, 8], yieldUnit: 'q/acre', baseIncome: 82000, baseMargin: 150, sustainability: 82, plantingSeason: 'January-February', harvestingSeason: 'April-May', imageKeyword: 'sunflower crop field' },
    castor: { displayName: 'Castor', category: 'oilseed', soils: ['red soil', 'sandy loam', 'black soil'], climates: ['dry', 'semi arid', 'hot'], seasons: ['kharif'], water: 'low', moisture: [18, 40], temp: [24, 36], rain: [40, 90], humidity: [25, 50], ph: [5.5, 8.0], N: [20, 50], P: [20, 45], K: [20, 50], yield: [4, 7], yieldUnit: 'q/acre', baseIncome: 74000, baseMargin: 150, sustainability: 90, plantingSeason: 'June-July', harvestingSeason: 'December-January', imageKeyword: 'castor crop field' },
    sugarcane: { displayName: 'Sugarcane', category: 'commercial crop', soils: ['alluvial', 'clay loam', 'loam'], climates: ['humid', 'tropical', 'warm'], seasons: ['monsoon', 'summer'], water: 'high', moisture: [55, 80], temp: [24, 35], rain: [100, 180], humidity: [60, 85], ph: [6.0, 8.0], N: [90, 160], P: [40, 80], K: [60, 120], yield: [28, 42], yieldUnit: 'tons/acre', baseIncome: 210000, baseMargin: 165, sustainability: 70, plantingSeason: 'January-March', harvestingSeason: '10-12 months', imageKeyword: 'sugarcane field' },
    tapioca: { displayName: 'Tapioca', category: 'commercial crop', soils: ['red soil', 'sandy loam', 'laterite'], climates: ['tropical', 'warm'], seasons: ['monsoon', 'summer'], water: 'medium', moisture: [35, 60], temp: [24, 34], rain: [70, 140], humidity: [45, 75], ph: [5.5, 7.5], N: [50, 100], P: [25, 55], K: [70, 130], yield: [10, 18], yieldUnit: 'tons/acre', baseIncome: 150000, baseMargin: 165, sustainability: 80, plantingSeason: 'June-August', harvestingSeason: '8-10 months', imageKeyword: 'tapioca field', regions: ['Salem', 'Namakkal', 'Erode'] },
    turmeric: { displayName: 'Turmeric', category: 'spice', soils: ['loam', 'alluvial', 'well drained'], climates: ['humid', 'tropical'], seasons: ['monsoon'], water: 'medium', moisture: [40, 65], temp: [20, 32], rain: [90, 160], humidity: [55, 80], ph: [5.5, 7.5], N: [55, 105], P: [25, 55], K: [70, 130], yield: [14, 22], yieldUnit: 'q/acre', baseIncome: 190000, baseMargin: 185, sustainability: 84, plantingSeason: 'May-June', harvestingSeason: 'January-February', imageKeyword: 'turmeric crop field', regions: ['Erode', 'Salem', 'Coimbatore'] },
    betelvine: { displayName: 'Betel Vine', category: 'commercial crop', soils: ['alluvial', 'loam', 'well drained'], climates: ['humid', 'tropical'], seasons: ['monsoon', 'summer'], water: 'high', moisture: [60, 85], temp: [24, 34], rain: [120, 220], humidity: [70, 90], ph: [5.5, 7.0], N: [60, 110], P: [25, 55], K: [50, 100], yield: [8, 12], yieldUnit: 'q/acre', baseIncome: 240000, baseMargin: 210, sustainability: 72, plantingSeason: 'June-September', harvestingSeason: 'Year-round picking', imageKeyword: 'betel vine cultivation', regions: ['Karur', 'Trichy', 'Thanjavur'] },
    chilli: { displayName: 'Chilli', category: 'spice', soils: ['sandy loam', 'loam', 'black soil'], climates: ['warm', 'dry', 'semi arid'], seasons: ['kharif', 'summer', 'rabi'], water: 'medium', moisture: [30, 55], temp: [20, 32], rain: [50, 100], humidity: [40, 65], ph: [6.0, 7.5], N: [50, 95], P: [25, 55], K: [50, 95], yield: [7, 11], yieldUnit: 'q/acre', baseIncome: 170000, baseMargin: 195, sustainability: 78, plantingSeason: 'June-July', harvestingSeason: 'November-January', imageKeyword: 'chilli crop field', regions: ['Virudhunagar', 'Ramanathapuram'] },
    coriander: { displayName: 'Coriander', category: 'spice', soils: ['loam', 'alluvial', 'well drained'], climates: ['cool', 'dry', 'warm'], seasons: ['winter', 'rabi'], water: 'medium', moisture: [30, 55], temp: [18, 28], rain: [40, 90], humidity: [35, 60], ph: [6.0, 7.8], N: [35, 75], P: [20, 50], K: [25, 50], yield: [4, 7], yieldUnit: 'q/acre', baseIncome: 88000, baseMargin: 160, sustainability: 82, plantingSeason: 'October-November', harvestingSeason: 'January-February', imageKeyword: 'coriander crop field' },
    cumin: { displayName: 'Cumin', category: 'spice', soils: ['sandy loam', 'loam'], climates: ['dry', 'cool'], seasons: ['winter', 'rabi'], water: 'low', moisture: [20, 40], temp: [15, 27], rain: [20, 60], humidity: [20, 45], ph: [6.5, 8.0], N: [25, 55], P: [20, 45], K: [20, 45], yield: [2, 4], yieldUnit: 'q/acre', baseIncome: 98000, baseMargin: 175, sustainability: 80, plantingSeason: 'November-December', harvestingSeason: 'February-March', imageKeyword: 'cumin crop field', regions: ['Dindigul', 'Madurai'] },
    onion: { displayName: 'Onion', category: 'spice', soils: ['loam', 'sandy loam', 'alluvial'], climates: ['warm', 'dry'], seasons: ['rabi', 'summer'], water: 'medium', moisture: [30, 55], temp: [18, 30], rain: [40, 90], humidity: [40, 65], ph: [6.0, 7.5], N: [50, 95], P: [25, 55], K: [40, 85], yield: [50, 90], yieldUnit: 'q/acre', baseIncome: 160000, baseMargin: 170, sustainability: 76, plantingSeason: 'October-November', harvestingSeason: 'February-March', imageKeyword: 'onion farm field', regions: ['Perambalur', 'Namakkal'] },
    garlic: { displayName: 'Garlic', category: 'spice', soils: ['loam', 'sandy loam', 'well drained'], climates: ['cool', 'dry'], seasons: ['winter', 'rabi'], water: 'medium', moisture: [30, 55], temp: [16, 28], rain: [35, 80], humidity: [35, 60], ph: [6.0, 7.5], N: [45, 85], P: [25, 55], K: [40, 80], yield: [18, 30], yieldUnit: 'q/acre', baseIncome: 155000, baseMargin: 175, sustainability: 77, plantingSeason: 'October-November', harvestingSeason: 'February-March', imageKeyword: 'garlic crop field' },
    guava: { displayName: 'Guava', category: 'perennial fruit', soils: ['loam', 'alluvial', 'well drained'], climates: ['tropical', 'subtropical'], seasons: ['monsoon', 'summer'], water: 'medium', moisture: [35, 60], temp: [20, 34], rain: [60, 140], humidity: [45, 75], ph: [5.5, 7.5], N: [50, 95], P: [25, 50], K: [60, 110], yield: [6, 10], yieldUnit: 'tons/acre', baseIncome: 190000, baseMargin: 180, sustainability: 82, plantingSeason: 'June-September', harvestingSeason: '8-10 months / seasonal flush', imageKeyword: 'guava orchard farm' },
    sapota: { displayName: 'Sapota', category: 'perennial fruit', soils: ['alluvial', 'loam', 'red soil'], climates: ['tropical', 'warm'], seasons: ['summer', 'monsoon'], water: 'medium', moisture: [35, 60], temp: [22, 34], rain: [70, 150], humidity: [45, 75], ph: [6.0, 8.0], N: [55, 100], P: [25, 50], K: [60, 110], yield: [6, 10], yieldUnit: 'tons/acre', baseIncome: 210000, baseMargin: 185, sustainability: 80, plantingSeason: 'June-September', harvestingSeason: 'Year-round flush', imageKeyword: 'sapota orchard farm' },
    amla: { displayName: 'Amla', category: 'perennial fruit', soils: ['light loam', 'alluvial', 'red soil'], climates: ['dry', 'subtropical', 'warm'], seasons: ['monsoon'], water: 'low', moisture: [20, 45], temp: [20, 34], rain: [40, 110], humidity: [30, 60], ph: [6.0, 8.5], N: [30, 70], P: [20, 45], K: [25, 50], yield: [5, 8], yieldUnit: 'tons/acre', baseIncome: 160000, baseMargin: 170, sustainability: 90, plantingSeason: 'July-September', harvestingSeason: 'November-February', imageKeyword: 'amla orchard farm' },
    jackfruit: { displayName: 'Jackfruit', category: 'perennial fruit', soils: ['loam', 'alluvial', 'well drained'], climates: ['humid', 'tropical'], seasons: ['monsoon'], water: 'medium', moisture: [40, 65], temp: [24, 34], rain: [100, 200], humidity: [60, 85], ph: [5.5, 7.5], N: [50, 90], P: [20, 50], K: [60, 110], yield: [7, 11], yieldUnit: 'tons/acre', baseIncome: 180000, baseMargin: 175, sustainability: 83, plantingSeason: 'June-September', harvestingSeason: 'March-June', imageKeyword: 'jackfruit orchard farm' },
    tomato: { displayName: 'Tomato', category: 'vegetable', soils: ['sandy loam', 'loam', 'well drained'], climates: ['warm', 'subtropical'], seasons: ['winter', 'summer', 'monsoon'], water: 'medium', moisture: [35, 60], temp: [18, 30], rain: [45, 100], humidity: [45, 70], ph: [6.0, 7.0], N: [55, 100], P: [25, 55], K: [55, 100], yield: [8, 14], yieldUnit: 'tons/acre', baseIncome: 165000, baseMargin: 180, sustainability: 76, plantingSeason: 'October-November / June-July', harvestingSeason: '70-90 days', imageKeyword: 'tomato farm field' },
    brinjal: { displayName: 'Brinjal', category: 'vegetable', soils: ['loam', 'sandy loam', 'alluvial'], climates: ['warm', 'humid'], seasons: ['summer', 'monsoon', 'winter'], water: 'medium', moisture: [35, 60], temp: [22, 32], rain: [50, 110], humidity: [45, 70], ph: [5.5, 7.5], N: [55, 100], P: [25, 55], K: [50, 95], yield: [8, 14], yieldUnit: 'tons/acre', baseIncome: 150000, baseMargin: 175, sustainability: 75, plantingSeason: 'June-July / October-November', harvestingSeason: '75-100 days', imageKeyword: 'brinjal farm field' },
    okra: { displayName: 'Bhindi / Okra', category: 'vegetable', soils: ['sandy loam', 'loam', 'well drained'], climates: ['hot', 'warm'], seasons: ['summer', 'kharif'], water: 'medium', moisture: [30, 55], temp: [24, 36], rain: [45, 100], humidity: [40, 65], ph: [6.0, 7.5], N: [45, 85], P: [20, 50], K: [35, 75], yield: [5, 9], yieldUnit: 'tons/acre', baseIncome: 140000, baseMargin: 172, sustainability: 78, plantingSeason: 'February-March / June-July', harvestingSeason: '55-75 days', imageKeyword: 'okra farm field' },
    drumstick: { displayName: 'Drumstick', category: 'vegetable', soils: ['red soil', 'sandy loam', 'loam'], climates: ['hot', 'dry', 'tropical'], seasons: ['summer', 'monsoon'], water: 'low', moisture: [20, 45], temp: [24, 36], rain: [35, 90], humidity: [30, 55], ph: [6.0, 8.0], N: [35, 75], P: [20, 45], K: [30, 60], yield: [6, 10], yieldUnit: 'tons/acre', baseIncome: 170000, baseMargin: 180, sustainability: 88, plantingSeason: 'June-August', harvestingSeason: '6-8 months', imageKeyword: 'drumstick farm field' },
    cabbage: { displayName: 'Cabbage', category: 'vegetable', soils: ['loam', 'silt loam', 'well drained'], climates: ['cool', 'temperate', 'hill'], seasons: ['winter', 'rabi'], water: 'medium', moisture: [40, 65], temp: [15, 24], rain: [60, 110], humidity: [55, 80], ph: [6.0, 7.5], N: [60, 110], P: [30, 60], K: [50, 90], yield: [10, 16], yieldUnit: 'tons/acre', baseIncome: 155000, baseMargin: 170, sustainability: 74, plantingSeason: 'September-November', harvestingSeason: '75-100 days', imageKeyword: 'cabbage farm field', regions: ['The Nilgiris', 'Kodaikanal'] },
    cauliflower: { displayName: 'Cauliflower', category: 'vegetable', soils: ['loam', 'silt loam', 'well drained'], climates: ['cool', 'temperate', 'hill'], seasons: ['winter', 'rabi'], water: 'medium', moisture: [40, 65], temp: [15, 24], rain: [60, 110], humidity: [55, 80], ph: [6.0, 7.5], N: [60, 110], P: [30, 60], K: [50, 90], yield: [8, 14], yieldUnit: 'tons/acre', baseIncome: 160000, baseMargin: 172, sustainability: 74, plantingSeason: 'September-November', harvestingSeason: '80-110 days', imageKeyword: 'cauliflower farm field', regions: ['The Nilgiris', 'Kodaikanal'] },
    gourds: { displayName: 'Gourds', category: 'vegetable', soils: ['sandy loam', 'loam', 'alluvial'], climates: ['warm', 'humid'], seasons: ['summer', 'monsoon'], water: 'medium', moisture: [35, 60], temp: [22, 34], rain: [50, 110], humidity: [45, 75], ph: [6.0, 7.5], N: [45, 90], P: [20, 50], K: [40, 85], yield: [8, 14], yieldUnit: 'tons/acre', baseIncome: 145000, baseMargin: 170, sustainability: 77, plantingSeason: 'January-March / June-July', harvestingSeason: '60-90 days', imageKeyword: 'gourd vegetable farm' },
    beans: { displayName: 'Beans', category: 'vegetable', soils: ['loam', 'sandy loam', 'well drained'], climates: ['cool', 'warm', 'hill'], seasons: ['winter', 'summer'], water: 'medium', moisture: [35, 60], temp: [18, 28], rain: [50, 100], humidity: [45, 70], ph: [6.0, 7.5], N: [35, 80], P: [20, 50], K: [30, 60], yield: [5, 9], yieldUnit: 'tons/acre', baseIncome: 135000, baseMargin: 168, sustainability: 80, plantingSeason: 'October-November / February-March', harvestingSeason: '60-80 days', imageKeyword: 'beans crop field' },
    tea: { displayName: 'Tea', category: 'plantation', soils: ['acidic', 'forest', 'well drained'], climates: ['cool', 'humid', 'hill'], seasons: ['monsoon', 'winter'], water: 'high', moisture: [55, 80], temp: [16, 28], rain: [140, 260], humidity: [70, 90], ph: [4.5, 5.8], N: [70, 120], P: [25, 55], K: [80, 140], yield: [500, 900], yieldUnit: 'kg/acre', baseIncome: 220000, baseMargin: 178, sustainability: 82, plantingSeason: 'June-September', harvestingSeason: 'Continuous plucking', imageKeyword: 'tea plantation', regions: ['The Nilgiris'] },
    cardamom: { displayName: 'Cardamom', category: 'spice plantation', soils: ['forest', 'loam', 'well drained'], climates: ['humid', 'hill', 'tropical'], seasons: ['monsoon'], water: 'high', moisture: [55, 80], temp: [18, 28], rain: [140, 260], humidity: [75, 92], ph: [5.5, 6.8], N: [60, 110], P: [25, 50], K: [60, 110], yield: [120, 220], yieldUnit: 'kg/acre', baseIncome: 280000, baseMargin: 210, sustainability: 76, plantingSeason: 'June-August', harvestingSeason: 'Second year onward', imageKeyword: 'cardamom plantation', regions: ['The Nilgiris', 'Theni'] },
    pepper: { displayName: 'Pepper', category: 'spice plantation', soils: ['forest', 'loam', 'well drained'], climates: ['humid', 'tropical', 'hill'], seasons: ['monsoon'], water: 'high', moisture: [50, 75], temp: [20, 32], rain: [120, 240], humidity: [70, 90], ph: [5.5, 6.8], N: [55, 100], P: [20, 45], K: [60, 110], yield: [180, 320], yieldUnit: 'kg/acre', baseIncome: 240000, baseMargin: 195, sustainability: 80, plantingSeason: 'June-September', harvestingSeason: 'December-February', imageKeyword: 'pepper plantation', regions: ['The Nilgiris', 'Kanyakumari'] },
    arecanut: { displayName: 'Arecanut', category: 'plantation', soils: ['alluvial', 'loam', 'coastal'], climates: ['humid', 'tropical'], seasons: ['monsoon'], water: 'high', moisture: [55, 80], temp: [20, 34], rain: [120, 240], humidity: [70, 90], ph: [5.5, 7.0], N: [60, 110], P: [25, 50], K: [70, 130], yield: [600, 1000], yieldUnit: 'kg/acre', baseIncome: 220000, baseMargin: 185, sustainability: 79, plantingSeason: 'June-September', harvestingSeason: '4-5 years onward', imageKeyword: 'arecanut plantation', regions: ['Kanyakumari', 'The Nilgiris'] },
    jasmine: { displayName: 'Jasmine', category: 'flower crop', soils: ['red soil', 'loam', 'well drained'], climates: ['warm', 'dry', 'tropical'], seasons: ['summer', 'monsoon'], water: 'medium', moisture: [30, 55], temp: [22, 34], rain: [50, 110], humidity: [45, 70], ph: [6.0, 7.5], N: [45, 85], P: [20, 45], K: [35, 75], yield: [1800, 2600], yieldUnit: 'kg/acre', baseIncome: 260000, baseMargin: 205, sustainability: 78, plantingSeason: 'June-September', harvestingSeason: 'Year-round flowering', imageKeyword: 'jasmine flower farm', regions: ['Madurai', 'Dindigul'] },
    marigold: { displayName: 'Marigold', category: 'flower crop', soils: ['loam', 'sandy loam', 'well drained'], climates: ['warm', 'subtropical'], seasons: ['summer', 'winter'], water: 'medium', moisture: [30, 55], temp: [18, 30], rain: [45, 100], humidity: [40, 70], ph: [6.0, 7.5], N: [40, 80], P: [20, 45], K: [35, 70], yield: [4, 7], yieldUnit: 'tons/acre', baseIncome: 150000, baseMargin: 178, sustainability: 76, plantingSeason: 'June-July / October-November', harvestingSeason: '60-75 days', imageKeyword: 'marigold flower farm' },
    rose: { displayName: 'Rose', category: 'flower crop', soils: ['loam', 'sandy loam', 'well drained'], climates: ['mild', 'subtropical', 'hill'], seasons: ['winter', 'summer'], water: 'medium', moisture: [35, 60], temp: [18, 30], rain: [50, 110], humidity: [45, 75], ph: [6.0, 7.5], N: [45, 85], P: [20, 45], K: [40, 75], yield: [3, 5], yieldUnit: 'tons/acre', baseIncome: 190000, baseMargin: 185, sustainability: 74, plantingSeason: 'June-September', harvestingSeason: 'Continuous flowering', imageKeyword: 'rose flower farm' }
};

function persistDynamicCropCatalog(catalog) {
    try {
        fsModule.mkdirSync(path.dirname(dynamicCropCatalogPath), { recursive: true });
        fsModule.mkdirSync(dynamicCropCatalogBackupDir, { recursive: true });

        const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
        fsModule.writeFileSync(dynamicCropCatalogPath, serialized, 'utf8');
        fsModule.writeFileSync(dynamicCropCatalogBackupPath, serialized, 'utf8');
    } catch (error) {
        console.warn('[DATASET] Failed to persist dynamic crop catalog:', error.message);
    }
}

function loadDynamicCropCatalog(defaultCatalog) {
    try {
        if (fsModule.existsSync(dynamicCropCatalogPath)) {
            const parsed = JSON.parse(fsModule.readFileSync(dynamicCropCatalogPath, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length) {
                persistDynamicCropCatalog(parsed);
                return parsed;
            }
        }
    } catch (error) {
        console.warn('[DATASET] Failed to read dynamic crop catalog JSON, using in-code fallback:', error.message);
    }

    persistDynamicCropCatalog(defaultCatalog);
    return defaultCatalog;
}

dynamicCropRecommendationCatalog = loadDynamicCropCatalog(dynamicCropRecommendationCatalog);

const cultivationDatasetPath = path.join(__dirname, 'Crop Recommendation datasets', 'crop_cultivation_catalog.json');
const cultivationDatasetBackupDir = path.join(__dirname, 'Crop Recommendation datasets', 'backups');
const cultivationDatasetBackupPath = path.join(cultivationDatasetBackupDir, 'crop_cultivation_catalog.backup.json');

function normalizeCropIdentity(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildCropSelectionId(selection = {}) {
    const existingId = selection.id || selection.cropId || selection._id;
    if (existingId) return String(existingId);

    const normalizedCrop = normalizeCropIdentity(selection.crop || selection.name || 'crop');
    const selectedAt = String(selection.selectedAt || 'legacy').trim();
    return `${normalizedCrop || 'crop'}--${selectedAt}`;
}

function inferCultivationCategory(key, meta = {}) {
    if (meta.category) return meta.category;
    const normalized = normalizeCropIdentity(key);
    if (['rice', 'maize', 'ragi', 'pearlmillet', 'foxtailmillet', 'littlemillet', 'kodomillet', 'sorghum', 'wheat'].includes(normalized)) return 'food crop';
    if (['blackgram', 'chickpea', 'kidneybeans', 'lentil', 'mothbeans', 'mungbean', 'pigeonpeas', 'cowpea', 'horsegram'].includes(normalized)) return 'pulse';
    if (['groundnut', 'sesame', 'sunflower', 'castor'].includes(normalized)) return 'oilseed';
    if (['sugarcane', 'cotton', 'banana', 'tapioca', 'jute', 'turmeric', 'betelvine'].includes(normalized)) return 'commercial crop';
    if (['chilli', 'coriander', 'cumin', 'onion', 'garlic'].includes(normalized)) return 'spice';
    if (['tea', 'coffee', 'cardamom', 'pepper', 'arecanut'].includes(normalized)) return 'plantation';
    if (['mango', 'guava', 'sapota', 'amla', 'jackfruit', 'papaya', 'apple', 'orange', 'pomegranate', 'grapes', 'watermelon', 'muskmelon', 'coconut'].includes(normalized)) return 'perennial fruit';
    if (['tomato', 'brinjal', 'okra', 'drumstick', 'cabbage', 'cauliflower', 'gourds', 'beans'].includes(normalized)) return 'vegetable';
    if (['jasmine', 'marigold', 'rose'].includes(normalized)) return 'flower crop';
    return 'general';
}

const cultivationCategoryTemplates = {
    'food crop': {
        seedRatePerAcre: 12,
        seedUnit: 'kg',
        basalFertilizerPerAcre: 60,
        topDressFertilizerPerAcre: 40,
        manurePerAcre: 2,
        manureUnit: 'tons',
        ploughingSchedule: 'Plough 2 to 3 times before sowing and break clods well.',
        landPreparation: 'Prepare a fine tilth, remove weeds, and level the field for uniform establishment.',
        sowingMethod: 'Line sowing or transplanting depending on crop and local practice.',
        irrigationGuidance: 'Provide life irrigation after sowing and follow crop-stage irrigation scheduling.',
        durationDaysMin: 95,
        durationDaysMax: 125,
        costPerAcre: 18000,
        notes: 'Use certified seed and maintain timely weed management for better stand establishment.'
    },
    pulse: {
        seedRatePerAcre: 10,
        seedUnit: 'kg',
        basalFertilizerPerAcre: 35,
        topDressFertilizerPerAcre: 15,
        manurePerAcre: 1.5,
        manureUnit: 'tons',
        ploughingSchedule: 'Plough 2 times and form a well-drained seed bed.',
        landPreparation: 'Create a friable seed bed with good drainage and incorporate organic matter.',
        sowingMethod: 'Line sowing with proper spacing and seed treatment before sowing.',
        irrigationGuidance: 'Usually needs fewer irrigations; avoid standing water.',
        durationDaysMin: 75,
        durationDaysMax: 105,
        costPerAcre: 12000,
        notes: 'Seed treatment and drainage are important for pulse crops.'
    },
    oilseed: {
        seedRatePerAcre: 8,
        seedUnit: 'kg',
        basalFertilizerPerAcre: 40,
        topDressFertilizerPerAcre: 20,
        manurePerAcre: 1.5,
        manureUnit: 'tons',
        ploughingSchedule: 'Plough 2 to 3 times and maintain a loose, weed-free field.',
        landPreparation: 'Prepare a firm but well-aerated seed bed and apply manure before final ploughing.',
        sowingMethod: 'Line sowing or dibbling with spacing suited to the crop.',
        irrigationGuidance: 'Irrigate lightly and avoid waterlogging, especially during flowering.',
        durationDaysMin: 85,
        durationDaysMax: 120,
        costPerAcre: 14000,
        notes: 'Critical irrigation during flowering and pod/capsule filling improves yield.'
    },
    'commercial crop': {
        seedRatePerAcre: 10,
        seedUnit: 'kg',
        basalFertilizerPerAcre: 75,
        topDressFertilizerPerAcre: 55,
        manurePerAcre: 3,
        manureUnit: 'tons',
        ploughingSchedule: 'Plough 2 to 4 times based on soil condition and form ridges/furrows if needed.',
        landPreparation: 'Deep plough once, incorporate FYM, and level or ridge the field according to crop need.',
        sowingMethod: 'Use line sowing, setts, suckers, rhizomes, or cuttings depending on crop.',
        irrigationGuidance: 'Follow regular irrigation with attention to establishment, vegetative growth, and reproductive stages.',
        durationDaysMin: 120,
        durationDaysMax: 300,
        costPerAcre: 26000,
        notes: 'Maintain nutrient scheduling and pest surveillance throughout the crop cycle.'
    },
    spice: {
        seedRatePerAcre: 5,
        seedUnit: 'kg',
        basalFertilizerPerAcre: 45,
        topDressFertilizerPerAcre: 25,
        manurePerAcre: 2,
        manureUnit: 'tons',
        ploughingSchedule: 'Plough 2 to 3 times and create raised beds or ridges where needed.',
        landPreparation: 'Prepare a well-drained field with good organic matter and fine tilth.',
        sowingMethod: 'Nursery raising, transplanting, or direct sowing depending on the crop.',
        irrigationGuidance: 'Light and regular irrigation is preferred; avoid excess moisture on foliage-sensitive crops.',
        durationDaysMin: 90,
        durationDaysMax: 180,
        costPerAcre: 22000,
        notes: 'Timely irrigation and nutrient management are essential for quality produce.'
    },
    plantation: {
        seedRatePerAcre: 450,
        seedUnit: 'plants',
        basalFertilizerPerAcre: 80,
        topDressFertilizerPerAcre: 60,
        manurePerAcre: 4,
        manureUnit: 'tons',
        ploughingSchedule: 'Prepare pits or planting basins after one deep ploughing and one leveling pass.',
        landPreparation: 'Open pits, enrich with manure, and ensure shade or support structures where required.',
        sowingMethod: 'Plant saplings, rooted cuttings, or nursery-raised planting material.',
        irrigationGuidance: 'Maintain consistent soil moisture, especially during establishment and dry spells.',
        durationDaysMin: 365,
        durationDaysMax: 1095,
        costPerAcre: 45000,
        notes: 'Mulching, shade management, and regular nutrient application are important.'
    },
    'perennial fruit': {
        seedRatePerAcre: 180,
        seedUnit: 'plants',
        basalFertilizerPerAcre: 65,
        topDressFertilizerPerAcre: 45,
        manurePerAcre: 4,
        manureUnit: 'tons',
        ploughingSchedule: 'Deep plough once, then prepare pits/basins and refill with manure-rich soil.',
        landPreparation: 'Layout the orchard, mark spacing, and prepare pits with compost or FYM.',
        sowingMethod: 'Plant grafts, saplings, suckers, or rooted cuttings as recommended for the crop.',
        irrigationGuidance: 'Provide life irrigation immediately after planting and maintain regular irrigation in summer.',
        durationDaysMin: 240,
        durationDaysMax: 540,
        costPerAcre: 38000,
        notes: 'Mulching, basin management, and formative pruning improve long-term performance.'
    },
    vegetable: {
        seedRatePerAcre: 4,
        seedUnit: 'kg',
        basalFertilizerPerAcre: 55,
        topDressFertilizerPerAcre: 35,
        manurePerAcre: 2.5,
        manureUnit: 'tons',
        ploughingSchedule: 'Plough 2 to 3 times and prepare raised beds or ridges for planting.',
        landPreparation: 'Prepare a fine tilth, incorporate manure, and ensure good drainage before sowing/transplanting.',
        sowingMethod: 'Nursery raising and transplanting or direct sowing depending on the crop.',
        irrigationGuidance: 'Irrigate at short intervals during establishment and fruiting stages.',
        durationDaysMin: 60,
        durationDaysMax: 110,
        costPerAcre: 20000,
        notes: 'Use staking, mulching, and integrated pest management where required.'
    },
    'flower crop': {
        seedRatePerAcre: 2,
        seedUnit: 'kg',
        basalFertilizerPerAcre: 50,
        topDressFertilizerPerAcre: 30,
        manurePerAcre: 2,
        manureUnit: 'tons',
        ploughingSchedule: 'Plough 2 to 3 times and prepare beds with good drainage.',
        landPreparation: 'Incorporate FYM before the final ploughing and maintain a fine tilth.',
        sowingMethod: 'Raise nursery or plant cuttings/saplings depending on the flower crop.',
        irrigationGuidance: 'Maintain regular moisture and avoid prolonged dry stress during flowering.',
        durationDaysMin: 90,
        durationDaysMax: 180,
        costPerAcre: 24000,
        notes: 'Flower quality improves with timely pinching, nutrient management, and pest control.'
    },
    general: {
        seedRatePerAcre: 8,
        seedUnit: 'kg',
        basalFertilizerPerAcre: 45,
        topDressFertilizerPerAcre: 25,
        manurePerAcre: 2,
        manureUnit: 'tons',
        ploughingSchedule: 'Plough 2 to 3 times and prepare a clean field before sowing.',
        landPreparation: 'Prepare a fine tilth and incorporate available organic manure.',
        sowingMethod: 'Follow crop-specific line sowing or planting with recommended spacing.',
        irrigationGuidance: 'Schedule irrigation according to moisture availability and crop stage.',
        durationDaysMin: 90,
        durationDaysMax: 150,
        costPerAcre: 18000,
        notes: 'Use healthy planting material and monitor the field regularly.'
    }
};

const cultivationCropOverrides = {
    rice: { seedRatePerAcre: 24, seedUnit: 'kg', basalFertilizerPerAcre: 70, topDressFertilizerPerAcre: 55, manurePerAcre: 3, durationDaysMin: 110, durationDaysMax: 130, costPerAcre: 24000, sowingMethod: 'Raise nursery and transplant seedlings or use direct seeding depending on local practice.', irrigationGuidance: 'Maintain shallow standing water after establishment and drain before harvest.', ploughingSchedule: 'Wet plough 2 to 3 times and puddle before transplanting.' },
    maize: { seedRatePerAcre: 8, seedUnit: 'kg', basalFertilizerPerAcre: 60, topDressFertilizerPerAcre: 40, manurePerAcre: 2, durationDaysMin: 95, durationDaysMax: 115, costPerAcre: 18000, sowingMethod: 'Direct line sowing on ridges or flat beds with spacing suitable for hybrid maize.' },
    banana: { seedRatePerAcre: 700, seedUnit: 'suckers', basalFertilizerPerAcre: 90, topDressFertilizerPerAcre: 90, manurePerAcre: 8, durationDaysMin: 300, durationDaysMax: 390, costPerAcre: 70000, sowingMethod: 'Plant healthy suckers or tissue culture plants in pits with manure.', ploughingSchedule: 'Deep plough once, then prepare pits and basins before planting.' },
    coconut: { seedRatePerAcre: 70, seedUnit: 'seedlings', basalFertilizerPerAcre: 60, topDressFertilizerPerAcre: 45, manurePerAcre: 5, durationDaysMin: 1460, durationDaysMax: 2555, costPerAcre: 65000, sowingMethod: 'Plant quality seedlings in prepared pits with organic manure.', ploughingSchedule: 'One deep ploughing followed by pit preparation.' },
    cotton: { seedRatePerAcre: 3, seedUnit: 'kg', basalFertilizerPerAcre: 55, topDressFertilizerPerAcre: 35, manurePerAcre: 2, durationDaysMin: 150, durationDaysMax: 180, costPerAcre: 22000, sowingMethod: 'Direct dibbling or precision sowing on ridges with recommended spacing.' },
    sugarcane: { seedRatePerAcre: 1600, seedUnit: 'setts', basalFertilizerPerAcre: 95, topDressFertilizerPerAcre: 75, manurePerAcre: 6, durationDaysMin: 300, durationDaysMax: 365, costPerAcre: 52000, sowingMethod: 'Plant healthy two-budded or three-budded setts in furrows.', ploughingSchedule: 'Deep plough once and then form ridges/furrows before sett planting.' },
    turmeric: { seedRatePerAcre: 800, seedUnit: 'kg rhizomes', basalFertilizerPerAcre: 65, topDressFertilizerPerAcre: 45, manurePerAcre: 4, durationDaysMin: 210, durationDaysMax: 270, costPerAcre: 38000, sowingMethod: 'Plant seed rhizomes on ridges or beds after treating planting material.' },
    groundnut: { seedRatePerAcre: 55, seedUnit: 'kg', basalFertilizerPerAcre: 35, topDressFertilizerPerAcre: 20, manurePerAcre: 1.5, durationDaysMin: 105, durationDaysMax: 120, costPerAcre: 17000 },
    tomato: { seedRatePerAcre: 0.12, seedUnit: 'kg seed', basalFertilizerPerAcre: 60, topDressFertilizerPerAcre: 45, manurePerAcre: 3, durationDaysMin: 95, durationDaysMax: 125, costPerAcre: 32000, sowingMethod: 'Raise nursery and transplant healthy seedlings to the main field.' },
    onion: { seedRatePerAcre: 4, seedUnit: 'kg seed', basalFertilizerPerAcre: 55, topDressFertilizerPerAcre: 35, manurePerAcre: 3, durationDaysMin: 110, durationDaysMax: 130, costPerAcre: 28000 },
    chilli: { seedRatePerAcre: 0.4, seedUnit: 'kg seed', basalFertilizerPerAcre: 50, topDressFertilizerPerAcre: 35, manurePerAcre: 2.5, durationDaysMin: 140, durationDaysMax: 180, costPerAcre: 30000, sowingMethod: 'Raise nursery and transplant seedlings on ridges or beds.' },
    coffee: { seedRatePerAcre: 1100, seedUnit: 'seedlings', basalFertilizerPerAcre: 65, topDressFertilizerPerAcre: 50, manurePerAcre: 4, durationDaysMin: 730, durationDaysMax: 1095, costPerAcre: 50000 },
    tea: { seedRatePerAcre: 5200, seedUnit: 'cuttings/plants', basalFertilizerPerAcre: 80, topDressFertilizerPerAcre: 60, manurePerAcre: 4, durationDaysMin: 730, durationDaysMax: 1095, costPerAcre: 65000 },
    papaya: { seedRatePerAcre: 450, seedUnit: 'seedlings', basalFertilizerPerAcre: 60, topDressFertilizerPerAcre: 45, manurePerAcre: 4, durationDaysMin: 240, durationDaysMax: 300, costPerAcre: 36000 },
    mango: { seedRatePerAcre: 45, seedUnit: 'grafts', basalFertilizerPerAcre: 50, topDressFertilizerPerAcre: 35, manurePerAcre: 4, durationDaysMin: 365, durationDaysMax: 540, costPerAcre: 42000 },
    guava: {
        seedRatePerAcre: 180,
        seedUnit: 'plants',
        basalFertilizerPerAcre: 65,
        topDressFertilizerPerAcre: 45,
        manurePerAcre: 4,
        durationDaysMin: 730,
        durationDaysMax: 1095,
        costPerAcre: 38000,
        landPreparation: 'Layout the orchard at 6 m x 6 m spacing, mark rows, and prepare pits with compost or FYM in well-drained soil.',
        ploughingSchedule: 'Deep plough once, then prepare pits/basins and refill with manure-rich topsoil before planting.',
        sowingMethod: 'Plant healthy grafted guava saplings in prepared pits; avoid seed propagation for commercial orchards.',
        irrigationGuidance: 'Give life irrigation immediately after planting, then irrigate every 5-7 days in summer and every 10-15 days in cooler months. Maintain uniform soil moisture, avoid standing water, and reduce irrigation during heavy rainfall or before harvest flush.',
        notes: 'Use grafted plants for uniformity, maintain basin mulching, and begin formative pruning from the establishment stage.'
    },
    jasmine: { seedRatePerAcre: 1800, seedUnit: 'cuttings/saplings', basalFertilizerPerAcre: 50, topDressFertilizerPerAcre: 35, manurePerAcre: 3, durationDaysMin: 180, durationDaysMax: 240, costPerAcre: 34000 }
};

function buildCultivationDataset(defaultCatalog) {
    const cultivationCatalog = {};
    Object.entries(defaultCatalog || {}).forEach(([key, meta]) => {
        const category = inferCultivationCategory(key, meta);
        cultivationCatalog[key] = {
            crop: meta.displayName || beautifyCropLabel(key),
            category,
            ...(cultivationCategoryTemplates[category] || cultivationCategoryTemplates.general),
            ...(cultivationCropOverrides[key] || {})
        };
    });
    return cultivationCatalog;
}

function persistCultivationCatalog(catalog) {
    try {
        fsModule.mkdirSync(path.dirname(cultivationDatasetPath), { recursive: true });
        fsModule.mkdirSync(cultivationDatasetBackupDir, { recursive: true });
        const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
        fsModule.writeFileSync(cultivationDatasetPath, serialized, 'utf8');
        fsModule.writeFileSync(cultivationDatasetBackupPath, serialized, 'utf8');
    } catch (error) {
        console.warn('[DATASET] Failed to persist cultivation catalog:', error.message);
    }
}

function loadCultivationCatalog(defaultCatalog) {
    try {
        if (fsModule.existsSync(cultivationDatasetPath)) {
            const parsed = JSON.parse(fsModule.readFileSync(cultivationDatasetPath, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length) {
                persistCultivationCatalog(parsed);
                return parsed;
            }
        }
    } catch (error) {
        console.warn('[DATASET] Failed to read cultivation catalog JSON, using generated fallback:', error.message);
    }

    persistCultivationCatalog(defaultCatalog);
    return defaultCatalog;
}

const cropCultivationCatalog = loadCultivationCatalog(buildCultivationDataset(dynamicCropRecommendationCatalog));

function resolveCropCatalogEntry(cropName) {
    const normalized = normalizeCropIdentity(cropName);
    for (const [key, meta] of Object.entries(dynamicCropRecommendationCatalog)) {
        const candidates = [key, meta.displayName, beautifyCropLabel(key), meta.crop].filter(Boolean).map(normalizeCropIdentity);
        if (candidates.includes(normalized)) {
            return { key, meta };
        }
    }
    return null;
}

function formatScaledQuantity(value, unit) {
    const numeric = Number(value) || 0;
    const rounded = numeric < 1 ? numeric.toFixed(2) : numeric < 10 ? numeric.toFixed(1) : Math.round(numeric);
    return `${rounded} ${unit}`.trim();
}

function formatRangeValue(minValue, maxValue, decimals = 0) {
    const safeMin = Number.isFinite(Number(minValue)) ? Number(minValue) : 0;
    const safeMax = Number.isFinite(Number(maxValue)) ? Number(maxValue) : safeMin;
    const precision = Number.isInteger(decimals) ? decimals : 0;
    const format = (value) => {
        const numeric = Number(value);
        return precision > 0 ? numeric.toFixed(precision) : Math.round(numeric).toString();
    };
    return safeMin === safeMax ? format(safeMin) : `${format(Math.min(safeMin, safeMax))}-${format(Math.max(safeMin, safeMax))}`;
}

function formatQuantityRange(minValue, maxValue, unit, decimals = 0) {
    return `${formatRangeValue(minValue, maxValue, decimals)} ${unit}`.trim();
}

function formatCurrencyRange(minValue, maxValue) {
    const lower = Math.min(Number(minValue) || 0, Number(maxValue) || 0);
    const upper = Math.max(Number(minValue) || 0, Number(maxValue) || 0);
    return `${formatDynamicCurrency(lower)} - ${formatDynamicCurrency(upper)}`;
}

function isTreeOrPlantingMaterialCrop(cropKey = '', cultivation = {}) {
    const plantingUnit = String(cultivation.seedUnit || '').toLowerCase();
    return new Set(['guava', 'sapota', 'jackfruit', 'mango', 'amla', 'coconut', 'banana', 'papaya', 'pomegranate', 'apple', 'grapes', 'orange']).has(cropKey)
        || /(graft|plant|seedling|sapling|sucker|cutting)/.test(plantingUnit);
}

const STARTUP_CROP_PROFILES = {
    guava: {
        spacing: '5 m x 5 m to 6 m x 6 m',
        plantingMaterial: 'grafts',
        plantsPerAcreRange: [170, 180],
        pitSize: '0.6 m x 0.6 m x 0.6 m pits',
        ploughingRequirement: '1 deep ploughing followed by 2 cross cultivator passes',
        soilTreatment: 'Mix topsoil with well-decomposed FYM, neem cake, and Trichoderma before planting the grafts.',
        plantingSeason: 'June-August or January-February with assured irrigation',
        varieties: 'Lucknow 49 (Sardar), Allahabad Safeda, Lalit, Arka Kiran',
        nursery: 'Use 8-12 month old disease-free grafts from a certified nursery; avoid root-bound plants.',
        fymPerPlantKgRange: [10, 20],
        basalMultiplierRange: [0.9, 1.15],
        starterNpkFactorRange: [0.22, 0.32],
        firstIrrigation: 'Give life irrigation immediately after planting.',
        wateringSchedule: 'Irrigate every 5-7 days in summer and every 10-15 days in cool or rainy spells based on soil moisture.',
        firstHarvest: '2-3 years after planting',
        fullYield: '4th year onwards',
        annualIncomeMultiplierRange: [0.85, 1.2],
        startupCostMultiplierRange: [0.8, 1.6],
        startupCostShare: { landPreparation: 0.2, plantingMaterial: 0.35, fertilizers: 0.2, labour: 0.2, misc: 0.05 },
        marketDemand: 'Good demand in local fresh fruit markets, juice processors, and direct retail channels.',
        riskFactors: [
            'Monitor wilt, fruit fly, and anthracnose during the first 2 years.',
            'Avoid prolonged water stagnation after planting to reduce root stress.',
            'Summer irrigation gaps can reduce canopy establishment and delay first bearing.'
        ]
    },
    mango: {
        spacing: '8 m x 8 m to 10 m x 10 m',
        plantingMaterial: 'grafts',
        plantsPerAcreRange: [40, 55],
        pitSize: '1 m x 1 m x 1 m pits',
        ploughingRequirement: '1 deep ploughing followed by 2 leveling or harrow passes',
        soilTreatment: 'Refill pits with topsoil, 20-25 kg FYM, neem cake, and biofungicide before planting.',
        plantingSeason: 'July-September; February planting possible with irrigation support',
        varieties: 'Banganapalli, Alphonso, Imam Pasand, Neelum, Mallika',
        nursery: 'Select true-to-type grafts with healthy union and strong tap root development.',
        fymPerPlantKgRange: [20, 30],
        basalMultiplierRange: [0.9, 1.2],
        starterNpkFactorRange: [0.2, 0.3],
        firstIrrigation: 'Give life irrigation immediately after planting and mulch the basin.',
        wateringSchedule: 'Water every 5-7 days in dry months during year 1; reduce during rainy periods but do not allow wilting.',
        firstHarvest: '3-4 years after planting',
        fullYield: '5th year onwards',
        annualIncomeMultiplierRange: [0.8, 1.15],
        startupCostMultiplierRange: [0.9, 1.5],
        startupCostShare: { landPreparation: 0.22, plantingMaterial: 0.33, fertilizers: 0.18, labour: 0.22, misc: 0.05 },
        marketDemand: 'Strong seasonal demand in fresh fruit trade and bulk movement to urban markets.',
        riskFactors: [
            'Watch for hopper, powdery mildew, and fruit fly from vegetative stage onward.',
            'Young plants need wind protection and summer moisture support.',
            'Irregular flowering and fruit set are likely under severe drought or heat stress.'
        ]
    },
    sapota: {
        spacing: '8 m x 8 m to 9 m x 9 m',
        plantingMaterial: 'grafts',
        plantsPerAcreRange: [55, 70],
        pitSize: '0.75 m to 1 m cube pits',
        ploughingRequirement: '1 deep ploughing followed by 2 cross harrowings',
        soilTreatment: 'Mix pit soil with FYM, neem cake, and micronutrient-enriched compost before planting.',
        plantingSeason: 'June-August or late monsoon with irrigation support',
        varieties: 'PKM-1, Kalipatti, Cricket Ball, CO-2',
        nursery: 'Use uniform softwood grafts with straight stem and healthy root ball.',
        fymPerPlantKgRange: [15, 25],
        basalMultiplierRange: [0.9, 1.15],
        starterNpkFactorRange: [0.22, 0.32],
        firstIrrigation: 'Give life irrigation immediately after planting.',
        wateringSchedule: 'Water every 6-8 days in summer and extend to 10-14 days in cooler months if soil retains moisture.',
        firstHarvest: '2.5-3 years after planting',
        fullYield: '4th year onwards',
        annualIncomeMultiplierRange: [0.82, 1.18],
        startupCostMultiplierRange: [0.85, 1.45],
        startupCostShare: { landPreparation: 0.2, plantingMaterial: 0.34, fertilizers: 0.2, labour: 0.21, misc: 0.05 },
        marketDemand: 'Steady demand in fresh fruit markets and neighborhood retail channels.',
        riskFactors: [
            'Leaf spot and bud borer should be watched during establishment.',
            'Heavy clay soils without drainage can suppress root growth.',
            'Long dry spells without basin irrigation may reduce early canopy formation.'
        ]
    },
    jackfruit: {
        spacing: '8 m x 8 m to 10 m x 10 m',
        plantingMaterial: 'grafts',
        plantsPerAcreRange: [40, 60],
        pitSize: '1 m x 1 m x 1 m pits',
        ploughingRequirement: '1 deep ploughing and 2 field preparation passes before pit marking',
        soilTreatment: 'Mix excavated soil with FYM, neem cake, and Trichoderma before filling pits.',
        plantingSeason: 'June-August with monsoon support; irrigated planting also possible in January-February',
        varieties: 'Panruti Selection, Singapore Jack, Palur-1, local firm-flesh grafts',
        nursery: 'Use grafts with healthy union and sturdy stem; avoid elongated nursery plants.',
        fymPerPlantKgRange: [20, 30],
        basalMultiplierRange: [0.9, 1.15],
        starterNpkFactorRange: [0.2, 0.3],
        firstIrrigation: 'Give life irrigation immediately after planting and stake the young graft.',
        wateringSchedule: 'Provide weekly irrigation in dry weather during the first year; shift to 10-12 day interval after establishment if mulch is applied.',
        firstHarvest: '3-4 years after planting',
        fullYield: '5th year onwards',
        annualIncomeMultiplierRange: [0.78, 1.12],
        startupCostMultiplierRange: [0.9, 1.5],
        startupCostShare: { landPreparation: 0.22, plantingMaterial: 0.3, fertilizers: 0.2, labour: 0.23, misc: 0.05 },
        marketDemand: 'Good local demand for fresh fruit, chips, and value-added processing.',
        riskFactors: [
            'Stem and root rot risk is high in poorly drained pits.',
            'Young trees are vulnerable to wind damage and termite attack.',
            'Delayed irrigation in summer can slow early canopy establishment.'
        ]
    },
    banana: {
        spacing: '1.8 m x 1.5 m to 2 m x 2 m',
        plantingMaterial: 'suckers / tissue culture plants',
        plantsPerAcreRange: [1000, 1450],
        pitSize: '45 cm cube pits or raised beds with drainage channels',
        ploughingRequirement: '2-3 ploughings with ridge and furrow formation',
        soilTreatment: 'Apply well-decomposed FYM, neem cake, and pseudomonas or Trichoderma in pits before planting.',
        plantingSeason: 'June-September or January-February with irrigation',
        varieties: 'Grand Naine, Poovan, Rasthali, Monthan, Ney Poovan',
        nursery: 'Use sword suckers or hardened tissue culture plants from approved sources only.',
        fymPerPlantKgRange: [8, 12],
        basalMultiplierRange: [0.95, 1.2],
        starterNpkFactorRange: [0.35, 0.45],
        firstIrrigation: 'Irrigate immediately after planting to settle the soil around suckers.',
        wateringSchedule: 'Water every 3-5 days during establishment; continue weekly scheduling based on soil type, mulch, and rainfall.',
        firstHarvest: '11-13 months after planting',
        fullYield: 'From first crop itself under good establishment',
        annualIncomeMultiplierRange: [0.85, 1.15],
        startupCostMultiplierRange: [0.9, 1.3],
        startupCostShare: { landPreparation: 0.18, plantingMaterial: 0.28, fertilizers: 0.24, labour: 0.24, misc: 0.06 },
        marketDemand: 'Good demand for fresh market, ripening units, and wholesale banana trade.',
        riskFactors: [
            'Panama wilt, sigatoka, and pseudostem borer should be monitored early.',
            'Wind damage and waterlogging can affect newly planted stands.',
            'High water demand makes summer irrigation planning critical.'
        ]
    },
    papaya: {
        spacing: '1.8 m x 1.8 m to 2 m x 2 m',
        plantingMaterial: 'seedlings',
        plantsPerAcreRange: [900, 1200],
        pitSize: '45 cm cube pits enriched with compost',
        ploughingRequirement: '2 ploughings and one leveling pass',
        soilTreatment: 'Treat pits with FYM, neem cake, and Trichoderma before transplanting seedlings.',
        plantingSeason: 'June-September or February-March with irrigation',
        varieties: 'Red Lady 786, CO-7, Pusa Nanha, Arka Prabhat',
        nursery: 'Raise seedlings in polybags and transplant 35-45 day old vigorous plants.',
        fymPerPlantKgRange: [5, 10],
        basalMultiplierRange: [0.9, 1.15],
        starterNpkFactorRange: [0.3, 0.4],
        firstIrrigation: 'Irrigate immediately after transplanting seedlings.',
        wateringSchedule: 'Water every 4-6 days in summer and every 7-10 days in cooler periods depending on drainage.',
        firstHarvest: '8-10 months after planting',
        fullYield: '2nd picking cycle onwards',
        annualIncomeMultiplierRange: [0.85, 1.18],
        startupCostMultiplierRange: [0.85, 1.25],
        startupCostShare: { landPreparation: 0.17, plantingMaterial: 0.26, fertilizers: 0.24, labour: 0.26, misc: 0.07 },
        marketDemand: 'Consistent demand from fresh fruit markets and juice units.',
        riskFactors: [
            'Papaya ring spot virus and collar rot can affect new plantings.',
            'Heavy rainfall with poor drainage can lead to root diseases.',
            'Summer water stress reduces fruit set and plant vigor.'
        ]
    },
    pomegranate: {
        spacing: '4.5 m x 3 m to 5 m x 4 m',
        plantingMaterial: 'grafts / rooted cuttings',
        plantsPerAcreRange: [200, 300],
        pitSize: '60 cm cube pits',
        ploughingRequirement: '1 deep ploughing followed by 2 harrowings and pit layout',
        soilTreatment: 'Enrich pits with FYM, neem cake, and micronutrient mix before planting.',
        plantingSeason: 'June-August or January-February with drip irrigation',
        varieties: 'Bhagwa, Ganesh, Mridula, Arakta',
        nursery: 'Use true-to-type disease-free grafts or rooted cuttings with well-branched roots.',
        fymPerPlantKgRange: [8, 12],
        basalMultiplierRange: [0.9, 1.15],
        starterNpkFactorRange: [0.25, 0.35],
        firstIrrigation: 'Give life irrigation immediately after planting.',
        wateringSchedule: 'Water every 5-7 days during establishment and adjust under drip based on soil moisture and rainfall.',
        firstHarvest: '18-24 months after planting',
        fullYield: '3rd year onwards',
        annualIncomeMultiplierRange: [0.88, 1.22],
        startupCostMultiplierRange: [0.9, 1.45],
        startupCostShare: { landPreparation: 0.18, plantingMaterial: 0.32, fertilizers: 0.22, labour: 0.22, misc: 0.06 },
        marketDemand: 'High demand in premium fresh fruit channels and inter-state trade.',
        riskFactors: [
            'Bacterial blight and sucking pests must be monitored from early growth stage.',
            'Cracking risk rises under irregular irrigation or heat stress.',
            'New orchards need assured drip irrigation for stable establishment.'
        ]
    },
    coconut: {
        spacing: '7.5 m x 7.5 m to 8 m x 8 m',
        plantingMaterial: 'seedlings',
        plantsPerAcreRange: [65, 75],
        pitSize: '1 m x 1 m x 1 m pits',
        ploughingRequirement: '1 deep ploughing and field leveling before pit layout',
        soilTreatment: 'Fill pits with topsoil, sand where needed, FYM, and neem cake before planting.',
        plantingSeason: 'June-September with monsoon moisture or December-January with irrigation',
        varieties: 'East Coast Tall, Chowghat Orange Dwarf, COD x WCT hybrids',
        nursery: 'Plant 8-10 month old healthy seedlings with at least 6 leaves and good girth.',
        fymPerPlantKgRange: [15, 25],
        basalMultiplierRange: [0.9, 1.15],
        starterNpkFactorRange: [0.18, 0.28],
        firstIrrigation: 'Irrigate immediately after planting and mulch the basin.',
        wateringSchedule: 'Water every 5-7 days in summer during the first year; reduce interval with basin mulch and rainfall support.',
        firstHarvest: '4-5 years after planting',
        fullYield: '7th year onwards',
        annualIncomeMultiplierRange: [0.78, 1.1],
        startupCostMultiplierRange: [0.9, 1.35],
        startupCostShare: { landPreparation: 0.24, plantingMaterial: 0.28, fertilizers: 0.2, labour: 0.22, misc: 0.06 },
        marketDemand: 'Stable demand across copra, tender coconut, and fresh nut markets.',
        riskFactors: [
            'Rhinoceros beetle and red palm weevil management should start early.',
            'Low rainfall zones need assured basin irrigation in summer.',
            'Salinity or prolonged drought can delay juvenile growth.'
        ]
    }
};

function getStartupCropProfile(cropKey, cultivation, acres) {
    const guide = STARTUP_CROP_PROFILES[cropKey];
    if (guide) return guide;

    const seedUnit = String(cultivation.seedUnit || '').toLowerCase();
    const isPlantingMaterial = /(graft|plant|seedling|sapling|sucker|cutting)/.test(seedUnit);
    const perAcreRate = Number(cultivation.seedRatePerAcre) || 0;
    return {
        spacing: isPlantingMaterial ? 'Follow crop-specific row and plant spacing recommended for your district' : 'Use line sowing with recommended row spacing for the crop',
        plantingMaterial: cultivation.seedUnit || 'seed',
        plantsPerAcreRange: isPlantingMaterial ? [Math.max(1, Math.round(perAcreRate * 0.9)), Math.max(1, Math.round(perAcreRate * 1.1))] : null,
        pitSize: isPlantingMaterial ? 'Prepare pits or beds according to local recommendation for this crop' : 'Prepare raised beds or ridges if drainage is poor',
        ploughingRequirement: String(cultivation.ploughingSchedule || 'Prepare the field with 2-3 ploughings before planting'),
        soilTreatment: 'Use FYM/compost, neem cake, and seed or root-zone bioprotectants before sowing or planting.',
        plantingSeason: 'Start with the current recommended season for your district and irrigation access',
        varieties: 'Choose certified, locally adapted, disease-tolerant varieties from an approved source',
        nursery: isPlantingMaterial ? 'Purchase healthy planting material from a certified nursery.' : 'Use certified seed and treat before sowing.',
        fymPerPlantKgRange: isPlantingMaterial && perAcreRate ? [5, 10] : null,
        basalMultiplierRange: [0.9, 1.15],
        starterNpkFactorRange: [0.3, 0.4],
        firstIrrigation: isPlantingMaterial ? 'Give life irrigation immediately after planting.' : 'Give a light irrigation immediately after sowing if soil moisture is low.',
        wateringSchedule: String(cultivation.irrigationGuidance || 'Plan irrigation according to crop stage and soil moisture.'),
        firstHarvest: `${Math.max(1, Math.round((Number(cultivation.durationDaysMin) || 90) / 30))}-${Math.max(2, Math.round((Number(cultivation.durationDaysMax) || 120) / 30))} months after planting`,
        fullYield: isPlantingMaterial ? 'After establishment phase under regular management' : 'From the first main crop under good management',
        annualIncomeMultiplierRange: [0.82, 1.15],
        startupCostMultiplierRange: [0.9, 1.25],
        startupCostShare: { landPreparation: 0.2, plantingMaterial: 0.25, fertilizers: 0.22, labour: 0.26, misc: 0.07 },
        marketDemand: 'Market demand depends on seasonal arrivals, quality, and local buyer linkages.',
        riskFactors: [
            'Monitor crop-specific pests and diseases from the nursery or early vegetative stage.',
            'Weather swings and drainage issues can reduce initial establishment.',
            'Plan irrigation carefully to avoid moisture stress in the first 30-45 days.'
        ]
    };
}

function buildCultivationNotes(context = {}, cropMeta = {}, recommendation = null) {
    const notes = [];
    if (Number.isFinite(context.ph) && Array.isArray(cropMeta.ph)) {
        notes.push(`Soil pH ${context.ph} should be managed within the ideal ${cropMeta.ph[0]}-${cropMeta.ph[1]} range.`);
    }
    if (Number.isFinite(context.rainfall)) {
        notes.push(`Current rainfall input (${context.rainfall} mm) should be considered while planning irrigation.`);
    }
    if (Number.isFinite(context.temperature)) {
        notes.push(`Temperature around ${context.temperature}°C should be monitored during establishment and flowering stages.`);
    }
    if (recommendation?.conditionSummary) {
        notes.push(recommendation.conditionSummary);
    }
    return notes.filter(Boolean).slice(0, 4);
}

function buildCropQuotation(selection = {}, user = {}) {
    const cropName = selection.crop || selection.name || '';
    const resolved = resolveCropCatalogEntry(cropName);
    if (!resolved) return null;

    const cultivation = cropCultivationCatalog[resolved.key];
    const cropMeta = resolved.meta || {};
    if (!cultivation) return null;

    const selectionContext = selection.selectionContext && typeof selection.selectionContext === 'object' ? selection.selectionContext : {};
    const acres = Math.max(0.1, Number(selectionContext.farmSize ?? user.farmSize) || 1);
    const waterAvailability = selectionContext.waterAvailability || user.waterAvailability || '';
    const durationMin = Number(cultivation.durationDaysMin) || 90;
    const durationMax = Number(cultivation.durationDaysMax) || durationMin + 20;
    const irrigationSuffix = waterAvailability
        ? ` Current water availability is ${waterAvailability}, so fine-tune the interval based on soil moisture.`
        : '';
    const startupGuide = getStartupCropProfile(resolved.key, cultivation, acres);
    const isPlantingMaterialCrop = isTreeOrPlantingMaterialCrop(resolved.key, cultivation);
    const yieldPerAcre = cropMeta?.yield && cropMeta?.yield.length >= 2
        ? `${cropMeta.yield[0]}-${cropMeta.yield[1]} ${cropMeta.yieldUnit || ''}`.trim()
        : 'Not available';
    const plantsPerAcreRange = Array.isArray(startupGuide.plantsPerAcreRange) && startupGuide.plantsPerAcreRange.length === 2
        ? startupGuide.plantsPerAcreRange
        : null;
    const totalPlantRange = plantsPerAcreRange
        ? [
            Math.max(1, Math.round(Math.min(...plantsPerAcreRange) * acres)),
            Math.max(1, Math.round(Math.max(...plantsPerAcreRange) * acres))
        ]
        : null;
    const plantingMaterialLabel = startupGuide.plantingMaterial || cultivation.seedUnit || 'seed';
    const plantingMaterialRequirement = totalPlantRange
        ? `${formatRangeValue(totalPlantRange[0], totalPlantRange[1])} ${plantingMaterialLabel} for ${acres} acres`
        : `${formatScaledQuantity((Number(cultivation.seedRatePerAcre) || 0) * acres, cultivation.seedUnit || 'kg')} for ${acres} acres`;
    const spacing = startupGuide.spacing || 'Follow crop-specific spacing recommended for your district';
    const pitOrBedPreparation = isPlantingMaterialCrop
        ? `${startupGuide.pitSize || 'Prepare pits based on the crop spacing'} and keep them open for 2-3 weeks before refilling with enriched topsoil.`
        : `${startupGuide.pitSize || 'Prepare raised beds or ridges'} before sowing so the crop establishes in a well-drained seed bed.`;
    const fymRange = Array.isArray(startupGuide.fymPerPlantKgRange) && totalPlantRange
        ? [
            (Math.min(...startupGuide.fymPerPlantKgRange) * Math.min(...totalPlantRange)) / 1000,
            (Math.max(...startupGuide.fymPerPlantKgRange) * Math.max(...totalPlantRange)) / 1000
        ]
        : [
            Math.max(0.5, (Number(cultivation.manurePerAcre) || 1) * acres * 0.9),
            Math.max(0.75, (Number(cultivation.manurePerAcre) || 1) * acres * 1.2)
        ];
    const basalRange = [
        Math.max(1, (Number(cultivation.basalFertilizerPerAcre) || 0) * acres * Math.min(...(startupGuide.basalMultiplierRange || [1, 1]))),
        Math.max(1, (Number(cultivation.basalFertilizerPerAcre) || 0) * acres * Math.max(...(startupGuide.basalMultiplierRange || [1, 1])))
    ];
    const starterNpkRange = [
        Math.max(1, basalRange[0] * Math.min(...(startupGuide.starterNpkFactorRange || [0.3, 0.4]))),
        Math.max(1, basalRange[1] * Math.max(...(startupGuide.starterNpkFactorRange || [0.3, 0.4])))
    ];
    const startupCostRange = [
        Math.max(1000, (Number(cultivation.costPerAcre) || 20000) * acres * Math.min(...(startupGuide.startupCostMultiplierRange || [1, 1]))),
        Math.max(1500, (Number(cultivation.costPerAcre) || 20000) * acres * Math.max(...(startupGuide.startupCostMultiplierRange || [1, 1])))
    ];
    const startupCostShare = startupGuide.startupCostShare || {
        landPreparation: 0.2,
        plantingMaterial: 0.25,
        fertilizers: 0.22,
        labour: 0.26,
        misc: 0.07
    };
    const baseIncome = Number(cropMeta.baseIncome) || 0;
    const annualIncomeEstimate = baseIncome
        ? formatCurrencyRange(
            baseIncome * acres * Math.min(...(startupGuide.annualIncomeMultiplierRange || [0.85, 1.1])),
            baseIncome * acres * Math.max(...(startupGuide.annualIncomeMultiplierRange || [0.85, 1.1]))
        )
        : 'Depends on yield, grade, and market linkage after maturity';
    const landPrepCostRange = startupCostRange.map((value) => value * Number(startupCostShare.landPreparation || 0.2));
    const plantingMaterialCostRange = startupCostRange.map((value) => value * Number(startupCostShare.plantingMaterial || 0.25));
    const fertilizerCostRange = startupCostRange.map((value) => value * Number(startupCostShare.fertilizers || 0.22));
    const labourCostRange = startupCostRange.map((value) => value * Number(startupCostShare.labour || 0.26));
    const starterMaterialLabel = isPlantingMaterialCrop ? 'Saplings / grafts and nursery material' : 'Seed / nursery material';
    const cropDuration = durationMax >= 730
        ? 'Perennial setup with a long productive life under regular pruning, nutrition, and irrigation'
        : durationMax >= 365
            ? `Long-duration crop cycle of about ${Math.round(durationMin / 30)}-${Math.round(durationMax / 30)} months`
            : `${durationMin}-${durationMax} day crop cycle from planting to the first main harvest window`;
    const importantNotes = buildCultivationNotes({
        ph: Number(selectionContext.ph ?? selectionContext.pH ?? user.ph),
        rainfall: Number(selectionContext.rainfall ?? user.rainfall),
        temperature: Number(selectionContext.temperature ?? user.temperature)
    }, cropMeta, selection.recommendationSnapshot);
    const riskFactors = Array.isArray(startupGuide.riskFactors) ? [...startupGuide.riskFactors] : [];
    if (String(waterAvailability).toLowerCase() === 'low') {
        riskFactors.push('Low water availability means drip irrigation, mulching, and basin moisture monitoring are essential from day one.');
    }
    if (isPlantingMaterialCrop) {
        importantNotes.unshift('Use only true-to-type, disease-free planting material from a reliable nursery and avoid over-aged saplings.');
    } else {
        importantNotes.unshift('Use certified seed or treated planting material and complete sowing within the recommended seasonal window.');
    }

    return {
        crop: cultivation.crop || cropName,
        acreage: acres,
        setupMode: 'new_plantation',
        seedRequirement: plantingMaterialRequirement,
        plantingMaterialRequirement,
        spacing,
        plantsForAcreage: totalPlantRange
            ? `${formatRangeValue(totalPlantRange[0], totalPlantRange[1])} ${plantingMaterialLabel} for ${acres} acres at ${spacing}`
            : plantingMaterialRequirement,
        bestPlantingSeason: startupGuide.plantingSeason || 'Begin during the recommended local planting season with assured soil moisture',
        suitableVarieties: startupGuide.varieties || 'Choose certified locally adapted varieties',
        nurseryRecommendation: startupGuide.nursery || 'Source healthy planting material from a certified nursery or seed supplier',
        landPreparation: cultivation.landPreparation || 'Prepare a clean, well-drained field and incorporate organic matter before planting',
        ploughingRequired: startupGuide.ploughingRequirement || cultivation.ploughingSchedule || '2-3 ploughings before planting',
        pitBedPreparation: pitOrBedPreparation,
        soilTreatment: startupGuide.soilTreatment || 'Apply compost/FYM, neem cake, and recommended bio-inputs before sowing or planting',
        manureRequirement: formatQuantityRange(fymRange[0], fymRange[1], 'tons', 1),
        startupFym: formatQuantityRange(fymRange[0], fymRange[1], 'tons', 1),
        basalFertilizer: formatQuantityRange(basalRange[0], basalRange[1], 'kg'),
        starterNpkRecommendation: `Starter NPK mixture around ${formatQuantityRange(starterNpkRange[0], starterNpkRange[1], 'kg')} for ${acres} acres, applied in pits/beds and early root-zone establishment.`,
        sowingMethod: cultivation.sowingMethod || 'Follow the recommended planting method for this crop and spacing',
        irrigationGuidance: `${startupGuide.firstIrrigation || 'Irrigate immediately after planting.'} ${startupGuide.wateringSchedule || 'Follow a regular irrigation schedule during establishment.'}${irrigationSuffix}`.trim(),
        firstIrrigation: startupGuide.firstIrrigation || 'Irrigate immediately after planting.',
        weeklyWateringSchedule: `${startupGuide.wateringSchedule || 'Follow a regular irrigation schedule during establishment.'}${irrigationSuffix}`.trim(),
        cropDuration,
        firstHarvest: startupGuide.firstHarvest || `${durationMin}-${durationMax} days after planting`,
        expectedHarvestTime: startupGuide.firstHarvest || `${durationMin}-${durationMax} days after planting`,
        fullYieldStart: startupGuide.fullYield || 'After establishment under regular management',
        daysToHarvest: `${durationMin}-${durationMax} days`,
        estimatedCost: formatCurrencyRange(startupCostRange[0], startupCostRange[1]),
        initialCostEstimate: formatCurrencyRange(startupCostRange[0], startupCostRange[1]),
        startupCostBreakdown: {
            landPreparation: formatCurrencyRange(landPrepCostRange[0], landPrepCostRange[1]),
            seedSapling: formatCurrencyRange(plantingMaterialCostRange[0], plantingMaterialCostRange[1]),
            seedSaplingLabel: starterMaterialLabel,
            fertilizer: formatCurrencyRange(fertilizerCostRange[0], fertilizerCostRange[1]),
            labour: formatCurrencyRange(labourCostRange[0], labourCostRange[1]),
            total: formatCurrencyRange(startupCostRange[0], startupCostRange[1])
        },
        yieldPerAcre,
        expectedYield: `${yieldPerAcre} after establishment and regular management`,
        marketDemand: startupGuide.marketDemand || 'Demand depends on local fresh market, wholesale buyer access, and produce quality',
        profitPotential: `${annualIncomeEstimate} approximate yearly gross income after maturity, depending on yield and market price.`,
        annualIncomeEstimate,
        riskFactors,
        importantNotes
    };
}

function hydrateSelectedCrops(user = {}) {
    const rawSelections = Array.isArray(user.selectedCrops) ? user.selectedCrops : [];
    const unique = [];
    const seen = new Set();

    rawSelections.forEach((selection) => {
        const normalized = normalizeCropIdentity(selection?.crop);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        unique.push({
            ...selection,
            id: buildCropSelectionId(selection),
            quotation: buildCropQuotation(selection, user)
        });
    });

    return unique;
}

function buildPreferredCropText(selectedCrops = [], fallbackPreferred = '') {
    const names = selectedCrops
        .map((entry) => entry?.crop)
        .filter(Boolean);

    if (names.length) {
        return names.join(', ');
    }

    return String(fallbackPreferred || '').trim();
}

function sanitizeUserProfilePayload(payload = {}, existingUser = {}) {
    const next = {};

    if (Object.prototype.hasOwnProperty.call(payload, 'name')) {
        next.name = String(payload.name || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'email')) {
        next.email = String(payload.email || '').trim().toLowerCase();
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'phone')) {
        next.phone = String(payload.phone || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'address')) {
        next.address = String(payload.address || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'location')) {
        next.location = String(payload.location || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'farmSize')) {
        const parsedFarmSize = Number(payload.farmSize);
        next.farmSize = Number.isFinite(parsedFarmSize) && parsedFarmSize > 0 ? parsedFarmSize : null;
    }

    const existingSelections = Array.isArray(existingUser.selectedCrops) ? existingUser.selectedCrops : [];
    const normalizedSelections = Array.isArray(payload.selectedCrops)
        ? payload.selectedCrops.filter((entry) => entry && normalizeCropIdentity(entry.crop))
        : existingSelections;

    next.selectedCrops = normalizedSelections;

    const requestedPreferred = Object.prototype.hasOwnProperty.call(payload, 'preferredCrops')
        ? payload.preferredCrops
        : existingUser.preferredCrops;
    next.preferredCrops = buildPreferredCropText(normalizedSelections, requestedPreferred);

    return next;
}

function buildSafeUserResponse(user) {
    const safeUser = user?.toObject ? user.toObject() : JSON.parse(JSON.stringify(user || {}));
    delete safeUser.password;
    safeUser.selectedCrops = hydrateSelectedCrops(safeUser);
    safeUser.preferredCrops = buildPreferredCropText(safeUser.selectedCrops, safeUser.preferredCrops);
    return safeUser;
}

function normalizeDynamicRecommendationText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseDynamicRecommendationNumber(...values) {
    for (const value of values) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
    }
    return null;
}

function clampDynamicRecommendation(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}

function buildDynamicRangeFromCenter(center, spread, minSpread) {
    if (!Number.isFinite(center)) return null;
    const appliedSpread = Math.max(minSpread, Math.abs(center) * spread);
    return [center - appliedSpread, center + appliedSpread];
}

function mergeDynamicRanges(primary, secondary) {
    const first = Array.isArray(primary) && primary.length === 2 ? primary : null;
    const second = Array.isArray(secondary) && secondary.length === 2 ? secondary : null;
    if (first && second) {
        const firstMin = Math.min(Number(first[0]), Number(first[1]));
        const firstMax = Math.max(Number(first[0]), Number(first[1]));
        const secondMin = Math.min(Number(second[0]), Number(second[1]));
        const secondMax = Math.max(Number(second[0]), Number(second[1]));

        if (![firstMin, firstMax, secondMin, secondMax].every(Number.isFinite)) {
            return first;
        }

        const overlapMin = Math.max(firstMin, secondMin);
        const overlapMax = Math.min(firstMax, secondMax);

        if (overlapMin <= overlapMax) {
            return [overlapMin, overlapMax];
        }

        // If two sources disagree and do not overlap, prefer the narrower range
        // rather than expanding into an unrealistically broad band.
        const firstWidth = Math.max(0, firstMax - firstMin);
        const secondWidth = Math.max(0, secondMax - secondMin);
        return firstWidth <= secondWidth ? [firstMin, firstMax] : [secondMin, secondMax];
    }
    return first || second;
}

function scoreDynamicRange(value, range) {
    if (!Number.isFinite(value) || !Array.isArray(range) || range.length !== 2) return null;
    const min = Number(range[0]);
    const max = Number(range[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (value >= min && value <= max) return 1;
    const width = Math.max(1, max - min);
    const distance = value < min ? min - value : value - max;
    const softness = Math.max(width * 0.6, 6);
    return clampDynamicRecommendation(1 - (distance / softness));
}

function scoreDynamicTextMatch(inputText, keywords = []) {
    const normalized = normalizeDynamicRecommendationText(inputText);
    if (!normalized || !Array.isArray(keywords) || !keywords.length) return null;
    return keywords.some((keyword) => normalized.includes(normalizeDynamicRecommendationText(keyword))) ? 1 : 0;
}

function inferDynamicSoilType(avgPh, requestedSoilType, fallbackKeywords = []) {
    const requested = String(requestedSoilType || '').trim();
    if (requested) return requested;
    if (fallbackKeywords.length) return fallbackKeywords.map(toTitleCase).join(', ');
    if (avgPh < 5.8) return 'Acidic loam';
    if (avgPh > 7.5) return 'Alkaline alluvial soil';
    return 'Loamy to well-drained soil';
}

function inferDynamicWaterLevel(avgRainfall, avgHumidity, requestedWaterAvailability, soilMoisture = null) {
    const requested = String(requestedWaterAvailability || '').trim();
    if (requested) return toTitleCase(requested);
    if (Number.isFinite(soilMoisture)) {
        if (soilMoisture >= 65) return 'High';
        if (soilMoisture >= 40) return 'Medium';
        return 'Low';
    }
    const score = (Number(avgRainfall) || 0) + ((Number(avgHumidity) || 0) * 1.5);
    if (score >= 220) return 'High';
    if (score >= 140) return 'Medium';
    return 'Low';
}

function scoreDynamicWaterMatch(userWater, cropWater) {
    const order = { low: 0, medium: 1, high: 2 };
    const requested = normalizeDynamicRecommendationText(userWater);
    const expected = normalizeDynamicRecommendationText(cropWater);
    if (!requested || !expected || !(requested in order) || !(expected in order)) return null;
    const diff = Math.abs(order[requested] - order[expected]);
    if (diff === 0) return 1;
    if (diff === 1) return 0.55;
    return 0.1;
}

function formatDynamicRange(range, decimals = 0, suffix = '') {
    if (!Array.isArray(range) || range.length !== 2) return 'N/A';
    const min = Number(range[0]);
    const max = Number(range[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 'N/A';
    return `${min.toFixed(decimals)}-${max.toFixed(decimals)}${suffix}`;
}

function formatDynamicCurrency(value) {
    const numeric = Math.max(0, Math.round(Number(value) || 0));
    return `Rs. ${numeric.toLocaleString('en-IN')}`;
}

function dynamicSuitabilityLabel(score) {
    if (score >= 85) return 'Excellent';
    if (score >= 72) return 'High';
    if (score >= 58) return 'Moderate';
    return 'Low';
}

function normalizeDynamicRecommendationInput(input = {}) {
    const currentConditions = input.currentConditions && typeof input.currentConditions === 'object'
        ? input.currentConditions
        : {};

    return {
        soilType: String(input.soilType || '').trim(),
        climate: String(input.climate || '').trim(),
        season: String(input.season || '').trim(),
        location: String(input.location || input.district || input.region || '').trim(),
        waterAvailability: String(input.waterAvailability || '').trim(),
        farmSize: parseDynamicRecommendationNumber(input.farmSize),
        soilMoisture: parseDynamicRecommendationNumber(input.soilMoisture, currentConditions.soilMoisture),
        N: parseDynamicRecommendationNumber(input.n, input.N),
        P: parseDynamicRecommendationNumber(input.p, input.P),
        K: parseDynamicRecommendationNumber(input.k, input.K),
        temperature: parseDynamicRecommendationNumber(input.temperature, currentConditions.temperature),
        humidity: parseDynamicRecommendationNumber(input.humidity, currentConditions.humidity),
        ph: parseDynamicRecommendationNumber(input.ph, input.pH, currentConditions.pH, currentConditions.ph),
        rainfall: parseDynamicRecommendationNumber(input.rainfall, currentConditions.rainfall)
    };
}

function inferDynamicMoistureRange(waterLevel, explicitRange = null) {
    if (Array.isArray(explicitRange) && explicitRange.length === 2) {
        return explicitRange;
    }

    const normalizedWater = normalizeDynamicRecommendationText(waterLevel);
    if (normalizedWater === 'high') return [55, 80];
    if (normalizedWater === 'medium') return [35, 60];
    if (normalizedWater === 'low') return [20, 45];
    return null;
}

function scoreDynamicFarmSizeSuitability(farmSize, category) {
    if (!Number.isFinite(farmSize)) return null;

    const normalizedCategory = normalizeDynamicRecommendationText(category);
    const isSmallFarm = farmSize <= 2;
    const isLargeFarm = farmSize >= 5;

    if (isSmallFarm) {
        if (['vegetable', 'spice', 'flower crop'].includes(normalizedCategory)) return 1;
        if (['pulse', 'oilseed', 'food crop'].includes(normalizedCategory)) return 0.8;
        if (['commercial crop', 'perennial fruit'].includes(normalizedCategory)) return 0.62;
        if (['plantation', 'spice plantation'].includes(normalizedCategory)) return 0.5;
        return 0.72;
    }

    if (isLargeFarm) {
        if (['food crop', 'commercial crop', 'oilseed'].includes(normalizedCategory)) return 1;
        if (['pulse', 'vegetable', 'spice'].includes(normalizedCategory)) return 0.82;
        if (['perennial fruit', 'plantation', 'spice plantation'].includes(normalizedCategory)) return 0.74;
        return 0.8;
    }

    if (['food crop', 'pulse', 'oilseed', 'commercial crop', 'vegetable', 'spice'].includes(normalizedCategory)) return 0.95;
    if (['perennial fruit', 'flower crop'].includes(normalizedCategory)) return 0.82;
    if (['plantation', 'spice plantation'].includes(normalizedCategory)) return 0.72;
    return 0.85;
}

function buildDynamicDatasetRecommendations(input) {
    const normalizedInput = normalizeDynamicRecommendationInput(input);
    const labels = [...new Set([...Object.keys(cropDatasetProfiles || {}), ...Object.keys(dynamicCropRecommendationCatalog)])];
    if (!labels.length) {
        return {
            source: 'Strict Crop Dataset Scoring Engine',
            analysisSummary: 'No crop dataset is currently available for matching.',
            recommendations: []
        };
    }

    const factorWeights = {
        soil: 20,
        climate: 16,
        season: 16,
        water: 12,
        farmSize: 6,
        temperature: 10,
        humidity: 6,
        soilMoisture: 6,
        ph: 4,
        rainfall: 4
    };

    const providedCategoricalCount = ['soilType', 'climate', 'season', 'waterAvailability']
        .filter((key) => String(normalizedInput[key] || '').trim())
        .length;
    const providedNumericCount = ['temperature', 'humidity', 'soilMoisture', 'ph', 'rainfall', 'farmSize']
        .filter((key) => Number.isFinite(normalizedInput[key]))
        .length;
    const minimumExactMatches = providedCategoricalCount >= 3 ? 2 : providedCategoricalCount >= 1 ? 1 : 0;
    const minimumNumericMatches = providedNumericCount >= 4 ? 2 : providedNumericCount >= 2 ? 1 : 0;

    const cropDataset = labels.map((label) => {
        const profile = cropDatasetProfiles[label] || {};
        const meta = dynamicCropRecommendationCatalog[label] || {};
        const waterLevels = Array.isArray(meta.water) ? meta.water : (meta.water ? [meta.water] : []);

        return {
            key: label,
            name: meta.displayName || beautifyCropLabel(label),
            category: inferCultivationCategory(label, meta),
            soils: Array.isArray(meta.soils) ? meta.soils : [],
            climates: Array.isArray(meta.climates) ? meta.climates : [],
            seasons: Array.isArray(meta.seasons) ? meta.seasons : [],
            water: waterLevels,
            temperatureRange: mergeDynamicRanges(meta.temp, [profile.temperatureMin, profile.temperatureMax]),
            humidityRange: mergeDynamicRanges(meta.humidity, [profile.humidityMin, profile.humidityMax]),
            soilMoistureRange: inferDynamicMoistureRange(meta.water, meta.moisture),
            phRange: mergeDynamicRanges(meta.ph, [profile.phMin, profile.phMax]),
            rainfallRange: mergeDynamicRanges(meta.rain, [profile.rainfallMin, profile.rainfallMax]),
            yield: Array.isArray(meta.yield) ? meta.yield : [4, 8],
            yieldUnit: meta.yieldUnit || 'q/acre',
            baseIncome: Number(meta.baseIncome) || 80000,
            baseMargin: Number(meta.baseMargin) || 140,
            sustainability: Number(meta.sustainability) || 78,
            plantingSeason: meta.plantingSeason || toTitleCase(normalizedInput.season || 'Seasonal'),
            harvestingSeason: meta.harvestingSeason || '90-120 days after planting',
            imageKeyword: meta.imageKeyword || `${meta.displayName || beautifyCropLabel(label)} crop field`
        };
    });

    const scoredRecommendations = cropDataset.map((crop) => {
        let earnedScore = 0;
        let possibleScore = 0;
        let exactMatchCount = 0;
        let numericInRangeCount = 0;
        let categoricalMismatchCount = 0;
        const matchedFactors = [];
        const cautionFactors = [];

        const addFactorScore = (score, weight, matchText, mismatchText, options = {}) => {
            if (score === null || score === undefined) return;
            const {
                exactThreshold = 1,
                mismatchThreshold = 0.2,
                isCategorical = false
            } = options;

            possibleScore += weight;
            earnedScore += score * weight;

            if (score >= exactThreshold) {
                exactMatchCount += 1;
                if (!isCategorical) numericInRangeCount += 1;
                if (matchText) matchedFactors.push(matchText);
                return;
            }

            if (score <= mismatchThreshold && mismatchText) {
                cautionFactors.push(mismatchText);
                if (isCategorical) categoricalMismatchCount += 1;
            }
        };

        addFactorScore(
            scoreDynamicTextMatch(normalizedInput.soilType, crop.soils),
            factorWeights.soil,
            `soil matches ${crop.soils.map(toTitleCase).join(' / ')}`,
            `soil is better suited to ${crop.soils.map(toTitleCase).join(' / ')}`,
            { isCategorical: true }
        );
        addFactorScore(
            scoreDynamicTextMatch(normalizedInput.climate, crop.climates),
            factorWeights.climate,
            `climate matches ${crop.climates.map(toTitleCase).join(' / ')}`,
            `climate fit is stronger in ${crop.climates.map(toTitleCase).join(' / ')}`,
            { isCategorical: true }
        );
        addFactorScore(
            scoreDynamicTextMatch(normalizedInput.season, crop.seasons),
            factorWeights.season,
            `season aligns with ${crop.seasons.map(toTitleCase).join(' / ')}`,
            `best season is ${crop.seasons.map(toTitleCase).join(' / ')}`,
            { isCategorical: true }
        );
        addFactorScore(
            crop.water.length
                ? Math.max(...crop.water.map((waterLevel) => scoreDynamicWaterMatch(normalizedInput.waterAvailability, waterLevel) ?? 0))
                : null,
            factorWeights.water,
            `water need matches ${crop.water.map(toTitleCase).join(' / ')}`,
            `water need is closer to ${crop.water.map(toTitleCase).join(' / ')}`,
            { exactThreshold: 0.95, mismatchThreshold: 0.3, isCategorical: true }
        );
        addFactorScore(
            scoreDynamicFarmSizeSuitability(normalizedInput.farmSize, crop.category),
            factorWeights.farmSize,
            'farm size is workable for this crop',
            'farm size is less ideal for this crop',
            { exactThreshold: 0.9, mismatchThreshold: 0.45 }
        );
        addFactorScore(
            scoreDynamicRange(normalizedInput.temperature, crop.temperatureRange),
            factorWeights.temperature,
            `temperature fits ${formatDynamicRange(crop.temperatureRange, 0, 'C')}`,
            `temperature is outside ${formatDynamicRange(crop.temperatureRange, 0, 'C')}`,
            { exactThreshold: 0.99, mismatchThreshold: 0.3 }
        );
        addFactorScore(
            scoreDynamicRange(normalizedInput.humidity, crop.humidityRange),
            factorWeights.humidity,
            `humidity fits ${formatDynamicRange(crop.humidityRange, 0, '%')}`,
            `humidity is outside ${formatDynamicRange(crop.humidityRange, 0, '%')}`,
            { exactThreshold: 0.99, mismatchThreshold: 0.3 }
        );
        addFactorScore(
            scoreDynamicRange(normalizedInput.soilMoisture, crop.soilMoistureRange),
            factorWeights.soilMoisture,
            `soil moisture fits ${formatDynamicRange(crop.soilMoistureRange, 0, '%')}`,
            `soil moisture is outside ${formatDynamicRange(crop.soilMoistureRange, 0, '%')}`,
            { exactThreshold: 0.99, mismatchThreshold: 0.3 }
        );
        addFactorScore(
            scoreDynamicRange(normalizedInput.ph, crop.phRange),
            factorWeights.ph,
            `pH fits ${formatDynamicRange(crop.phRange, 1)}`,
            `pH is outside ${formatDynamicRange(crop.phRange, 1)}`,
            { exactThreshold: 0.99, mismatchThreshold: 0.3 }
        );
        addFactorScore(
            scoreDynamicRange(normalizedInput.rainfall, crop.rainfallRange),
            factorWeights.rainfall,
            `rainfall fits ${formatDynamicRange(crop.rainfallRange, 0, ' mm')}`,
            `rainfall is outside ${formatDynamicRange(crop.rainfallRange, 0, ' mm')}`,
            { exactThreshold: 0.99, mismatchThreshold: 0.3 }
        );

        if (!possibleScore) return null;

        const suitabilityScore = Math.round((earnedScore / possibleScore) * 100);
        const marketValue = crop.baseIncome * (0.8 + (suitabilityScore / 100) * 0.35);
        const profitMargin = `${Math.max(95, Math.round(crop.baseMargin + ((suitabilityScore - 65) * 1.1)))}%`;
        const sustainabilityScore = Math.max(60, Math.min(98, Math.round(crop.sustainability + ((suitabilityScore - 70) * 0.12))));
        const positiveSummary = matchedFactors.slice(0, 3);
        const cautionSummary = cautionFactors.slice(0, 2);

        return {
            crop: crop.name,
            suitabilityScore,
            suitability: dynamicSuitabilityLabel(suitabilityScore),
            description: [
                `${crop.name} matched ${positiveSummary[0] || 'the entered farm conditions'}.`,
                `${positiveSummary[1] || `Ideal ranges are ${formatDynamicRange(crop.temperatureRange, 0, 'C')}, ${formatDynamicRange(crop.humidityRange, 0, '%')} humidity, and pH ${formatDynamicRange(crop.phRange, 1)}`}.`,
                cautionSummary.length ? `Watch-outs: ${cautionSummary.join('; ')}.` : 'No major mismatches were found against the entered values.'
            ].join(' '),
            conditionSummary: positiveSummary.length ? positiveSummary.join(', ') : 'Moderate fit from the entered values',
            climateDetails: {
                tempRange: formatDynamicRange(crop.temperatureRange, 0, 'C'),
                humidity: formatDynamicRange(crop.humidityRange, 0, '%')
            },
            soilDetails: {
                ph: formatDynamicRange(crop.phRange, 1),
                moisture: formatDynamicRange(crop.soilMoistureRange, 0, '%'),
                type: crop.soils.length ? crop.soils.map(toTitleCase).join(', ') : inferDynamicSoilType(normalizedInput.ph ?? 6.5, normalizedInput.soilType, [])
            },
            waterRequirements: {
                level: crop.water.length ? crop.water.map(toTitleCase).join(' / ') : inferDynamicWaterLevel(normalizedInput.rainfall, normalizedInput.humidity, normalizedInput.waterAvailability, normalizedInput.soilMoisture),
                advice: crop.water.includes('high')
                    ? 'Needs consistently high moisture with drainage checks.'
                    : crop.water.includes('low')
                        ? 'Prefers lighter, well-timed irrigation and good drainage.'
                        : 'Performs best with moderate, steady soil moisture.'
            },
            yieldRange: `${Math.max(1, Math.round(crop.yield[0]))}-${Math.max(2, Math.round(crop.yield[1]))}`,
            yieldUnit: crop.yieldUnit,
            marketValue: formatDynamicCurrency(marketValue),
            profitMargin,
            sustainabilityScore,
            plantingSeason: crop.plantingSeason,
            harvestingSeason: crop.harvestingSeason,
            imageKeyword: crop.imageKeyword,
            recommendationReason: positiveSummary.length ? positiveSummary.join('; ') : `Dataset match calculated from the provided values for ${crop.name}.`,
            _exactMatchCount: exactMatchCount,
            _numericInRangeCount: numericInRangeCount,
            _categoricalMismatchCount: categoricalMismatchCount
        };
    }).filter(Boolean);

    const rankedRecommendations = scoredRecommendations
        .sort((a, b) => {
            if (b.suitabilityScore !== a.suitabilityScore) return b.suitabilityScore - a.suitabilityScore;
            if (b._exactMatchCount !== a._exactMatchCount) return b._exactMatchCount - a._exactMatchCount;
            return b._numericInRangeCount - a._numericInRangeCount;
        });

    if (!rankedRecommendations.length) {
        return {
            source: 'Strict Crop Dataset Scoring Engine',
            analysisSummary: 'No crop records were available to score.',
            recommendations: []
        };
    }

    const topScore = rankedRecommendations[0].suitabilityScore;
    let selectedRecommendations = rankedRecommendations.filter((recommendation) =>
        recommendation.suitabilityScore >= Math.max(55, topScore - 18) &&
        recommendation._exactMatchCount >= minimumExactMatches &&
        recommendation._numericInRangeCount >= minimumNumericMatches &&
        recommendation._categoricalMismatchCount <= 1
    );

    if (selectedRecommendations.length < 3) {
        selectedRecommendations = rankedRecommendations.filter((recommendation) =>
            recommendation.suitabilityScore >= Math.max(45, topScore - 25) &&
            recommendation._exactMatchCount >= Math.max(0, minimumExactMatches - 1) &&
            recommendation._categoricalMismatchCount <= 2
        );
    }

    const dedupedRecommendations = [];
    const seenCrops = new Set();
    const appendRecommendation = (recommendation) => {
        if (!recommendation || seenCrops.has(recommendation.crop) || dedupedRecommendations.length >= MAX_RECOMMENDATION_RESULTS) return;
        seenCrops.add(recommendation.crop);
        dedupedRecommendations.push(recommendation);
    };

    selectedRecommendations.forEach(appendRecommendation);

    if (dedupedRecommendations.length < MIN_RECOMMENDATION_RESULTS) {
        rankedRecommendations.forEach(appendRecommendation);
    }

    const cleanedRecommendations = dedupedRecommendations.map(({ _exactMatchCount, _numericInRangeCount, _categoricalMismatchCount, ...recommendation }) => recommendation);
    const summaryBits = [];
    if (normalizedInput.soilType) summaryBits.push(`soil ${normalizedInput.soilType}`);
    if (normalizedInput.climate) summaryBits.push(`climate ${normalizedInput.climate}`);
    if (normalizedInput.season) summaryBits.push(`season ${normalizedInput.season}`);
    if (normalizedInput.waterAvailability) summaryBits.push(`water ${normalizedInput.waterAvailability}`);
    if (Number.isFinite(normalizedInput.farmSize)) summaryBits.push(`farm size ${normalizedInput.farmSize} acres`);
    if (Number.isFinite(normalizedInput.temperature)) summaryBits.push(`temperature ${normalizedInput.temperature}C`);
    if (Number.isFinite(normalizedInput.humidity)) summaryBits.push(`humidity ${normalizedInput.humidity}%`);
    if (Number.isFinite(normalizedInput.soilMoisture)) summaryBits.push(`soil moisture ${normalizedInput.soilMoisture}%`);
    if (Number.isFinite(normalizedInput.ph)) summaryBits.push(`pH ${normalizedInput.ph}`);
    if (Number.isFinite(normalizedInput.rainfall)) summaryBits.push(`rainfall ${normalizedInput.rainfall} mm`);

    return {
        source: 'Strict Crop Dataset Scoring Engine',
        analysisSummary: cleanedRecommendations.length
            ? `Recommendations were scored directly against the entered values: ${summaryBits.join(', ')}. Only crops with meaningful soil, climate, season, water, farm-size, temperature, humidity, moisture, pH, and rainfall alignment are shown.`
            : `No crop matched the entered values closely enough: ${summaryBits.join(', ') || 'no usable inputs were provided'}. Try adjusting one or two conditions to see near matches.`,
        recommendations: cleanedRecommendations
    };
}

function buildCatalogRuleRecommendations(input, limit = MIN_RECOMMENDATION_RESULTS) {
    const normalizedInput = normalizeDynamicRecommendationInput(input);
    const entries = Object.entries(dynamicCropRecommendationCatalog || {});

    if (!entries.length) {
        return {
            source: 'Rule-Based Crop Fallback Engine',
            analysisSummary: 'Crop catalog is unavailable, so no fallback recommendations could be generated.',
            recommendations: []
        };
    }

    const recommendations = entries.map(([key, meta]) => {
        const cropName = meta.displayName || beautifyCropLabel(key);
        const soils = Array.isArray(meta.soils) ? meta.soils : [];
        const climates = Array.isArray(meta.climates) ? meta.climates : [];
        const seasons = Array.isArray(meta.seasons) ? meta.seasons : [];
        const waterLevels = Array.isArray(meta.water) ? meta.water : (meta.water ? [meta.water] : []);
        const temperatureRange = mergeDynamicRanges(meta.temp, null);
        const humidityRange = mergeDynamicRanges(meta.humidity, null);
        const soilMoistureRange = inferDynamicMoistureRange(meta.water, meta.moisture);
        const phRange = mergeDynamicRanges(meta.ph, null);
        const rainfallRange = mergeDynamicRanges(meta.rain, null);

        let score = 48;
        const matches = [];

        const soilScore = scoreDynamicTextMatch(normalizedInput.soilType, soils);
        if (soilScore !== null) {
            score += Math.round(soilScore * 16);
            if (soilScore >= 0.9) matches.push(`soil ${toTitleCase(normalizedInput.soilType)} fits`);
        }

        const climateScore = scoreDynamicTextMatch(normalizedInput.climate, climates);
        if (climateScore !== null) {
            score += Math.round(climateScore * 15);
            if (climateScore >= 0.9) matches.push(`climate ${toTitleCase(normalizedInput.climate)} matches`);
        }

        const seasonScore = scoreDynamicTextMatch(normalizedInput.season, seasons);
        if (seasonScore !== null) {
            score += Math.round(seasonScore * 15);
            if (seasonScore >= 0.9) matches.push(`season ${toTitleCase(normalizedInput.season)} aligns`);
        }

        if (waterLevels.length) {
            const waterScore = Math.max(...waterLevels.map((level) => scoreDynamicWaterMatch(normalizedInput.waterAvailability, level) ?? 0));
            score += Math.round(waterScore * 10);
            if (waterScore >= 0.95) matches.push(`water need suits ${toTitleCase(normalizedInput.waterAvailability)}`);
        }

        const temperatureScore = scoreDynamicRange(normalizedInput.temperature, temperatureRange);
        if (temperatureScore !== null) {
            score += Math.round(temperatureScore * 10);
            if (temperatureScore >= 0.99) matches.push(`temperature fits ${formatDynamicRange(temperatureRange, 0, 'C')}`);
        }

        const humidityScore = scoreDynamicRange(normalizedInput.humidity, humidityRange);
        if (humidityScore !== null) {
            score += Math.round(humidityScore * 8);
        }

        const moistureScore = scoreDynamicRange(normalizedInput.soilMoisture, soilMoistureRange);
        if (moistureScore !== null) {
            score += Math.round(moistureScore * 8);
        }

        const phScore = scoreDynamicRange(normalizedInput.ph, phRange);
        if (phScore !== null) {
            score += Math.round(phScore * 6);
        }

        const rainfallScore = scoreDynamicRange(normalizedInput.rainfall, rainfallRange);
        if (rainfallScore !== null) {
            score += Math.round(rainfallScore * 7);
        }

        const farmSizeScore = scoreDynamicFarmSizeSuitability(normalizedInput.farmSize, meta.category || inferCultivationCategory(key, meta));
        if (farmSizeScore !== null) {
            score += Math.round(farmSizeScore * 5);
        }

        if (String(normalizedInput.soilType || '').toLowerCase().includes('loam')) {
            if (['rice', 'wheat', 'sugarcane', 'maize', 'banana', 'groundnut', 'cotton'].some((term) => normalizeDynamicRecommendationText(cropName).includes(term))) {
                score += 6;
            }
        }
        if (String(normalizedInput.climate || '').toLowerCase().includes('tropical')) {
            if (['banana', 'coconut', 'cotton', 'papaya', 'guava', 'sapota', 'turmeric', 'rice', 'maize'].some((term) => normalizeDynamicRecommendationText(cropName).includes(term))) {
                score += 6;
            }
        }
        if (String(normalizedInput.season || '').toLowerCase().includes('monsoon')) {
            if (['rice', 'maize', 'banana', 'cotton', 'groundnut', 'turmeric', 'guava', 'sapota', 'jute'].some((term) => normalizeDynamicRecommendationText(cropName).includes(term))) {
                score += 6;
            }
        }

        const suitabilityScore = Math.max(52, Math.min(98, score));
        const yield = Array.isArray(meta.yield) ? meta.yield : [4, 8];
        const yieldUnit = meta.yieldUnit || 'q/acre';
        const waterLabel = waterLevels.length
            ? waterLevels.map(toTitleCase).join(' / ')
            : inferDynamicWaterLevel(normalizedInput.rainfall, normalizedInput.humidity, normalizedInput.waterAvailability, normalizedInput.soilMoisture);

        return {
            crop: cropName,
            suitabilityScore,
            suitability: dynamicSuitabilityLabel(suitabilityScore),
            description: `${cropName} is being recommended from the rule-based crop catalog using your soil, climate, season, water availability, and current field conditions. ${matches.length ? matches.join(', ') : 'It remains a workable all-round option for the entered values'}.`,
            conditionSummary: matches.length ? matches.slice(0, 3).join(', ') : 'Matched using crop catalog rules',
            climateDetails: {
                tempRange: formatDynamicRange(temperatureRange, 0, 'C'),
                humidity: formatDynamicRange(humidityRange, 0, '%')
            },
            soilDetails: {
                ph: formatDynamicRange(phRange, 1),
                moisture: formatDynamicRange(soilMoistureRange, 0, '%'),
                type: soils.length ? soils.map(toTitleCase).join(', ') : inferDynamicSoilType(normalizedInput.ph ?? 6.5, normalizedInput.soilType, [])
            },
            waterRequirements: {
                level: waterLabel,
                advice: waterLabel.toLowerCase().includes('high')
                    ? 'Keep moisture consistent and monitor drainage closely.'
                    : waterLabel.toLowerCase().includes('low')
                        ? 'Use lighter irrigation cycles and avoid waterlogging.'
                        : 'Maintain regular irrigation with moderate soil moisture.'
            },
            yieldRange: `${Math.max(1, Math.round(yield[0]))}-${Math.max(2, Math.round(yield[1]))}`,
            yieldUnit,
            marketValue: formatDynamicCurrency((Number(meta.baseIncome) || 90000) * (0.82 + (suitabilityScore / 100) * 0.35)),
            profitMargin: `${Math.max(100, Math.round((Number(meta.baseMargin) || 140) + ((suitabilityScore - 65) * 1.05)))}%`,
            sustainabilityScore: Math.max(60, Math.min(98, Math.round((Number(meta.sustainability) || 78) + ((suitabilityScore - 70) * 0.12)))),
            plantingSeason: meta.plantingSeason || toTitleCase(normalizedInput.season || 'Seasonal'),
            harvestingSeason: meta.harvestingSeason || '90-120 days after planting',
            imageKeyword: meta.imageKeyword || `${cropName} crop farming field`,
            recommendationReason: matches.length ? matches.join('; ') : `Selected from rule-based catalog scoring for ${cropName}.`
        };
    });

    const deduped = [];
    const seen = new Set();
    for (const recommendation of recommendations.sort((a, b) => b.suitabilityScore - a.suitabilityScore)) {
        const key = normalizeDynamicRecommendationText(recommendation.crop);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(recommendation);
        if (deduped.length >= limit) break;
    }

    return {
        source: 'Rule-Based Crop Fallback Engine',
        analysisSummary: deduped.length
            ? `Recommendations were generated from the crop rule catalog using soil ${normalizedInput.soilType || 'unknown'}, climate ${normalizedInput.climate || 'unknown'}, season ${normalizedInput.season || 'unknown'}, water ${normalizedInput.waterAvailability || 'unknown'}, and the current numeric conditions.`
            : 'Rule-based crop fallback could not find any matching entries, so the catalog returned no rows.',
        recommendations: deduped
    };
}

function buildRecommendationApiPayload(result, success = true) {
    const recommendations = Array.isArray(result?.recommendations)
        ? result.recommendations.filter(Boolean)
        : Array.isArray(result?.crops)
            ? result.crops.filter(Boolean)
            : [];

    return {
        success,
        message: result?.message || (recommendations.length
            ? 'Crop recommendations generated successfully.'
            : 'No suitable crops found for the selected conditions.'),
        source: result?.source || 'Crop Recommendation Engine',
        analysisSummary: result?.analysisSummary || (recommendations.length ? 'Crop recommendations generated successfully.' : 'No recommendation summary available.'),
        recommendations,
        crops: recommendations
    };
}


const axios = require('axios');

// AI Helpers (OpenRouter Migration - v4 Ultra-Stable)
const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
const cropRecommendationApiKey =
    process.env.CROP_RECOMMENDATION_OPENROUTER_API_KEY ||
    process.env.OPENROUTER_CROP_RECOMMENDATION_API_KEY ||
    '';
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const geminiAI = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
const getAIResponse = async (prompt, history = [], isChat = true, image = null, systemPrompt = null, apiKey = openRouterApiKey) => {
    if (!apiKey) {
        return null;
    }
    
    // Ordered models by reliability and typical free-tier availability on OpenRouter
    const models = [
        'openai/gpt-3.5-turbo',
        'google/gemini-flash-1.5',
        'google/gemini-2.0-flash-exp:free',
        'anthropic/claude-3-haiku',
        'meta-llama/llama-3.1-8b-instruct'
    ];

    for (const model of models) {
        try {
            console.log(`[AI-HUB] Testing model ${model}...`);
            
            let messages = [];
            if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

            if (isChat) {
                // Ensure messages are in simple role/content format
                const mappedHistory = history.map(h => ({
                    role: (h.role === 'model' || h.role === 'assistant' || h.role === 'ai') ? 'assistant' : 'user',
                    content: h.content || ""
                }));
                messages.push(...mappedHistory);
                messages.push({ role: 'user', content: prompt });
            } else if (image) {
                const imageDataUrl = `data:${image.mimeType};base64,${image.base64}`;
                messages.push({
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: imageDataUrl } },
                        { type: 'text', text: prompt }
                    ]
                });
                console.log('[AI-HUB] Vision request payload:', {
                    model,
                    mimeType: image.mimeType,
                    base64Length: image.base64.length,
                    contentTypes: ['image_url', 'text']
                });
            } else {
                messages.push({ role: 'user', content: prompt });
            }

            const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", 
                { model, messages },
                { 
                    headers: { 
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json' 
                    },
                    timeout: 20000 
                }
            );

            console.log('RAW API RESPONSE:', JSON.stringify(response.data));

            if (response.data?.choices?.[0]?.message?.content) {
                console.log(`[AI-HUB] ${model} Success!`);
                return response.data.choices[0].message.content;
            }
        } catch (e) {
            const errorOutput = e.response?.data?.error?.message || e.message;
            console.error(`[AI-HUB] ${model} Failure:`, errorOutput);
            
            // If the error indicates a fatal key issue, we should stop and report it
            if (errorOutput.toLowerCase().includes('api key') || errorOutput.toLowerCase().includes('credits')) {
                console.error('[AI-FATAL] Critical API Key or Credit issue detected.');
                break; 
            }
        }
    }
    return null;
};

const getGeminiResponse = async (prompt, systemPrompt = null) => {
    if (!geminiAI) return null;
    try {
        const response = await geminiAI.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: prompt,
            systemInstruction: systemPrompt || undefined,
            config: {
                responseMimeType: 'application/json',
                temperature: 0.6,
                topP: 0.9,
                maxOutputTokens: 4096
            }
        });
        return response.text || null;
    } catch (e) {
        console.error('[GEMINI] Recommendation generation failed:', e.message);
        return null;
    }
};

const genai = { models: { generateContent: () => { throw new Error('Use getAIResponse (OpenRouter)'); } } };
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

const getOpenAIVisionResponse = async (prompt, image, systemPrompt = null) => {
    if (!process.env.OPENAI_API_KEY || !image?.base64 || !image?.mimeType) {
        return null;
    }

    try {
        const imageDataUrl = `data:${image.mimeType};base64,${image.base64}`;
        console.log('[OPENAI] Vision request payload:', {
            model: 'gpt-4o-mini',
            mimeType: image.mimeType,
            base64Length: image.base64.length,
            contentTypes: ['input_text', 'input_image']
        });
        const response = await openai.responses.create({
            model: 'gpt-4o-mini',
            instructions: systemPrompt || undefined,
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: prompt },
                        {
                            type: 'input_image',
                            image_url: imageDataUrl,
                            detail: 'high'
                        }
                    ]
                }
            ],
            max_output_tokens: 4096
        });

        console.log('RAW API RESPONSE:', JSON.stringify(response));

        return response.output_text || null;
    } catch (e) {
        console.error('[OPENAI] Vision analysis failed:', e.message);
        return null;
    }
};

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TRUST_PROXY_VALUE = String(process.env.TRUST_PROXY || (IS_PRODUCTION ? '1' : '0')).trim().toLowerCase();
const SHOULD_TRUST_PROXY = TRUST_PROXY_VALUE === '1' || TRUST_PROXY_VALUE === 'true' || TRUST_PROXY_VALUE === 'yes';
const SESSION_SECRET = process.env.SESSION_SECRET || 'crop-ai-secret-2026';

if (SHOULD_TRUST_PROXY) {
    app.set('trust proxy', 1);
}

function getAppBaseUrl(req) {
    const configuredBaseUrl = process.env.APP_URL || process.env.BASE_URL;
    if (configuredBaseUrl) {
        return String(configuredBaseUrl).replace(/\/+$/, '');
    }

    const protocol = req?.protocol || 'http';
    const host = req?.get ? req.get('host') : '';
    return `${protocol}://${host}`.replace(/\/+$/, '');
}

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(session({
    secret: SESSION_SECRET,
    proxy: SHOULD_TRUST_PROXY,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: IS_PRODUCTION,
        sameSite: IS_PRODUCTION ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Email verification auth endpoints are now handled directly inside server.js APIs
// app.use('/', emailVerificationAuthRoutes);

// Global logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`📨 ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    next();
});

let emailTransporter = null;
let emailMode = 'pending';
const MAIL_BRAND_NAME = 'CropAI';
const VERIFICATION_EMAIL_SUBJECT = 'Verify your CropAI Email Address';

function getSupportEmail() {
    return process.env.SUPPORT_EMAIL || process.env.EMAIL_FROM || process.env.EMAIL_USER || 'support.cropai@gmail.com';
}

function getSmtpAuthUser() {
    return process.env.SMTP_AUTH_USER || process.env.EMAIL_USER;
}

function getSmtpAuthPass() {
    return process.env.SMTP_AUTH_PASS || process.env.EMAIL_PASS;
}

function getBrandedEmailFrom() {
    const senderEmail = process.env.EMAIL_FROM || getSupportEmail();
    return `"${MAIL_BRAND_NAME}" <${senderEmail}>`;
}

function buildVerificationEmailHtml(verificationUrl, name = '') {
    const supportEmail = getSupportEmail();
    const cleanedName = String(name || '').trim();
    const greeting = cleanedName ? `Hello, ${cleanedName}.` : 'Hello.';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0f1117;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0f1117;margin:0;padding:0;width:100%;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;width:100%;background:#151515;border:1px solid #31343a;border-radius:18px;">
          <tr>
            <td style="padding:40px 28px 36px;">
              <div style="text-align:center;color:#dff6e8;font-size:30px;line-height:1.2;font-weight:400;margin:0 0 28px;">
                Welcome to <span style="color:#16a34a;">CropAI</span>
              </div>
              <div style="color:#d8dde7;font-size:18px;line-height:1.6;margin:0 0 22px;">${greeting}</div>
              <div style="color:#b7bfcb;font-size:18px;line-height:1.8;margin:0 0 30px;">
                Thanks for creating an account with CropAI. To complete your signup, please confirm that this email address belongs to you.
              </div>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 30px;">
                <tr>
                  <td align="center">
                    <a href="${verificationUrl}" style="display:inline-block;background:#19a84a;color:#ffffff;text-decoration:none;padding:16px 30px;border-radius:12px;font-size:18px;line-height:1.2;min-width:200px;text-align:center;box-sizing:border-box;">
                      Verify Email
                    </a>
                  </td>
                </tr>
              </table>
              <div style="color:#b7bfcb;font-size:17px;line-height:1.8;margin:0 0 18px;">
                After verification, you'll be able to log in and access your dashboard, get AI crop recommendations, and explore our tools for farming optimization.
              </div>
              <div style="color:#a2aab5;font-size:16px;line-height:1.8;margin:0 0 28px;">
                If you didn't sign up for CropAI, please ignore this message. No further action is required.
              </div>
              <div style="border-top:1px solid #2c2f35;padding-top:22px;text-align:center;color:#8b93a0;font-size:14px;line-height:1.8;">
                You are receiving this email because you registered at CropAI.<br>
                Need help? Contact CropAI Support<br>
                <a href="mailto:${supportEmail}" style="color:#16a34a;text-decoration:none;">${supportEmail}</a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendBrandedEmail({ to, subject, html, text, replyTo }) {
    if (!emailTransporter) {
        throw new Error('Email transporter is not configured.');
    }

    return emailTransporter.sendMail({
        from: getBrandedEmailFrom(),
        to,
        subject,
        html,
        text,
        ...(replyTo ? { replyTo } : {})
    });
}

async function initEmailTransporter() {
    if (String(process.env.DISABLE_EMAIL || '').toLowerCase() === 'true') {
        emailMode = 'disabled';
        console.log('Email delivery disabled by DISABLE_EMAIL=true');
        return;
    }

    const gmailUser = getSmtpAuthUser();
    const gmailPass = getSmtpAuthPass();
    const hasGmailCreds = gmailUser &&
        gmailPass &&
        !gmailUser.includes('your_gmail') &&
        !gmailPass.includes('your_16') &&
        !gmailPass.includes('your_gmail_app_password');

    if (hasGmailCreds) {
        emailTransporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: { user: gmailUser, pass: gmailPass }
        });

        emailMode = 'gmail';
        console.log('Gmail SMTP configured. Delivery will be attempted when an email is sent.');
        return;
    }
    emailMode = 'disabled';
    console.log('Email delivery disabled. Set SMTP_AUTH_USER/SMTP_AUTH_PASS or EMAIL_USER/EMAIL_PASS to enable SMTP.');
}

initEmailTransporter();

const resetTokenStore = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of resetTokenStore.entries()) {
        if (data.expiresAt < now) resetTokenStore.delete(token);
    }
}, 30 * 60 * 1000);

const testEmail = 'test@example.com';
(async () => {
    try {
        if (!(await User.findOne({ email: testEmail }))) {
            const user = new User({
                name: 'Test User',
                username: 'testuser',
                email: testEmail,
                password: typeof bcrypt !== 'undefined' ? bcrypt.hashSync('password123', 10) : 'password123',
                isVerified: true
            });
            await user.save();
        }
    } catch(e) {}
})();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1082258284534-vunbjv19l2v3f089k9b4b0p9b4b0p9b4.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const uploadsDir = path.join(frontendDir, 'uploads');
if (!fsModule.existsSync(uploadsDir)) {
    fsModule.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = (file.originalname && path.extname(file.originalname)) || '.jpg';
        cb(null, `crop-${Date.now()}-${Math.floor(Math.random() * 1e9)}${ext}`);
    }
});
const allowedImageMimeTypes = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif'
]);

const imageFileFilter = (req, file, cb) => {
    if (!allowedImageMimeTypes.has(file.mimetype)) {
        return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    cb(null, true);
};

const upload = multer({
    storage,
    fileFilter: imageFileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }
});
const analyzeCropUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: imageFileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }
});
const detectCropUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: imageFileFilter,
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }
}).fields([
    { name: 'image', maxCount: 1 },
    { name: 'cropPhoto', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]);

const cropReferenceDir = path.join(frontendDir, 'images', 'Crop_images');
let cropReferenceLibraryPromise = null;

function normalizeReferenceCropName(filePath) {
    const base = path.basename(filePath, path.extname(filePath));
    const normalized = base
        .replace(/\s*\(.*?\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\bI\b/g, ' ')
        .trim();
    if (/^rice$/i.test(normalized)) return 'Paddy';
    return normalized;
}

async function extractImageSignature(input) {
    const { data, info } = await sharp(input)
        .rotate()
        .resize(48, 48, { fit: 'cover' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const pixelCount = info.width * info.height;
    const hueBins = new Array(12).fill(0);
    const thumbnail = [];
    let redRatio = 0;
    let greenRatio = 0;
    let yellowRatio = 0;
    let whiteRatio = 0;
    let brownRatio = 0;
    let meanR = 0;
    let meanG = 0;
    let meanB = 0;
    let edgeEnergy = 0;

    for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
            const idx = (y * info.width + x) * info.channels;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];

            meanR += r;
            meanG += g;
            meanB += b;

            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const delta = max - min;
            let hue = 0;
            if (delta > 0) {
                if (max === r) hue = ((g - b) / delta) % 6;
                else if (max === g) hue = (b - r) / delta + 2;
                else hue = (r - g) / delta + 4;
                hue *= 60;
                if (hue < 0) hue += 360;
            }
            hueBins[Math.min(11, Math.floor(hue / 30))] += 1;

            if (g > r + 10 && g > b + 6) greenRatio += 1;
            if (r > g + 18 && r > b + 12) redRatio += 1;
            if (r > 155 && g > 140 && b < 150) yellowRatio += 1;
            if (r > 185 && g > 185 && b > 185) whiteRatio += 1;
            if (r > 80 && g > 45 && b < 80 && r > g) brownRatio += 1;

            if (x < info.width - 1) {
                const nextIdx = idx + info.channels;
                edgeEnergy += Math.abs(r - data[nextIdx]) + Math.abs(g - data[nextIdx + 1]) + Math.abs(b - data[nextIdx + 2]);
            }
            if (y < info.height - 1) {
                const nextIdx = idx + info.width * info.channels;
                edgeEnergy += Math.abs(r - data[nextIdx]) + Math.abs(g - data[nextIdx + 1]) + Math.abs(b - data[nextIdx + 2]);
            }
        }
    }

    meanR /= pixelCount;
    meanG /= pixelCount;
    meanB /= pixelCount;

    const { data: thumbData, info: thumbInfo } = await sharp(input)
        .rotate()
        .resize(16, 16, { fit: 'cover' })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
    let thumbMean = 0;

    for (let i = 0; i < thumbInfo.width * thumbInfo.height; i++) {
        const value = Number((thumbData[i] / 255).toFixed(4));
        thumbnail.push(value);
        thumbMean += value;
    }
    thumbMean /= (thumbInfo.width * thumbInfo.height);
    const binaryHash = thumbnail.map((value) => value >= thumbMean ? 1 : 0);

    return {
        meanR: Number((meanR / 255).toFixed(4)),
        meanG: Number((meanG / 255).toFixed(4)),
        meanB: Number((meanB / 255).toFixed(4)),
        greenRatio: Number((greenRatio / pixelCount).toFixed(4)),
        redRatio: Number((redRatio / pixelCount).toFixed(4)),
        yellowRatio: Number((yellowRatio / pixelCount).toFixed(4)),
        whiteRatio: Number((whiteRatio / pixelCount).toFixed(4)),
        brownRatio: Number((brownRatio / pixelCount).toFixed(4)),
        edgeEnergy: Number((edgeEnergy / (pixelCount * 255 * 3)).toFixed(4)),
        hueBins: hueBins.map((value) => Number((value / pixelCount).toFixed(4))),
        thumbnail,
        binaryHash
    };
}

async function detectVisualCropFeatures(input) {
    const { data, info } = await sharp(input)
        .rotate()
        .resize(96, 96, { fit: 'inside', withoutEnlargement: false })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const visited = new Uint8Array(width * height);
    let whitePixelCount = 0;
    let greenPixelCount = 0;
    let grassLikePixelCount = 0;
    let cottonBollClusterCount = 0;
    let largestWhiteCluster = 0;

    const whiteMask = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * info.channels;
            const flat = y * width + x;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];

            const isWhite = r > 180 && g > 180 && b > 180 && Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) < 45;
            const isGreen = g > r + 12 && g > b + 8;
            const isGrassLike = isGreen && (y < height * 0.9) && (x > 0 && x < width - 1);

            if (isWhite) {
                whiteMask[flat] = 1;
                whitePixelCount += 1;
            }
            if (isGreen) greenPixelCount += 1;
            if (isGrassLike) grassLikePixelCount += 1;
        }
    }

    const directions = [
        [1, 0], [-1, 0], [0, 1], [0, -1]
    ];

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const start = y * width + x;
            if (!whiteMask[start] || visited[start]) continue;

            let clusterSize = 0;
            const queue = [start];
            visited[start] = 1;

            while (queue.length) {
                const current = queue.shift();
                clusterSize += 1;
                const cx = current % width;
                const cy = Math.floor(current / width);

                for (const [dx, dy] of directions) {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    const next = ny * width + nx;
                    if (!whiteMask[next] || visited[next]) continue;
                    visited[next] = 1;
                    queue.push(next);
                }
            }

            if (clusterSize >= 12) {
                cottonBollClusterCount += 1;
                largestWhiteCluster = Math.max(largestWhiteCluster, clusterSize);
            }
        }
    }

    const pixelCount = width * height;
    const whiteRatio = whitePixelCount / pixelCount;
    const greenRatio = greenPixelCount / pixelCount;
    const grassRatio = grassLikePixelCount / pixelCount;
    const cottonBollScore = Number(Math.max(0, (whiteRatio * 4.8) + (cottonBollClusterCount * 0.18) + (largestWhiteCluster / pixelCount * 5)).toFixed(4));
    const grassScore = Number(Math.max(0, (greenRatio * 2.4) + (grassRatio * 1.8) - (whiteRatio * 2.2)).toFixed(4));

    return {
        whiteRatio: Number(whiteRatio.toFixed(4)),
        greenRatio: Number(greenRatio.toFixed(4)),
        grassRatio: Number(grassRatio.toFixed(4)),
        cottonBollClusterCount,
        largestWhiteCluster,
        cottonBollScore,
        grassScore,
        hasCottonLikeBolls: cottonBollClusterCount >= 2 && whiteRatio >= 0.04,
        looksLikeGrassCrop: grassScore > 0.9 && cottonBollClusterCount === 0
    };
}

function signatureDistance(a, b) {
    const scalarKeys = ['meanR', 'meanG', 'meanB', 'greenRatio', 'redRatio', 'yellowRatio', 'whiteRatio', 'brownRatio', 'edgeEnergy'];
    let score = 0;

    for (const key of scalarKeys) {
        score += Math.abs((a[key] || 0) - (b[key] || 0)) * 2.5;
    }

    for (let i = 0; i < a.hueBins.length; i++) {
        score += Math.abs((a.hueBins[i] || 0) - (b.hueBins[i] || 0)) * 1.5;
    }

    for (let i = 0; i < a.thumbnail.length; i++) {
        score += Math.abs((a.thumbnail[i] || 0) - (b.thumbnail[i] || 0)) * 0.15;
    }

    const hashLength = Math.max(a.binaryHash?.length || 0, b.binaryHash?.length || 0);
    for (let i = 0; i < hashLength; i++) {
        score += ((a.binaryHash?.[i] || 0) === (b.binaryHash?.[i] || 0) ? 0 : 0.18);
    }

    return score;
}

async function getCropReferenceLibrary() {
    if (!cropReferenceLibraryPromise) {
        cropReferenceLibraryPromise = (async () => {
            if (!fsModule.existsSync(cropReferenceDir)) return [];
            const files = fsModule.readdirSync(cropReferenceDir)
                .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
                .map((file) => path.join(cropReferenceDir, file));

            const references = [];
            for (const file of files) {
                try {
                    references.push({
                        crop_name: normalizeReferenceCropName(file),
                        file,
                        signature: await extractImageSignature(file)
                    });
                } catch (error) {
                    console.warn('[PHOTO] Failed to load crop reference image:', file, error.message);
                }
            }
            console.log(`[PHOTO] Loaded ${references.length} local crop reference signatures.`);
            return references;
        })();
    }
    return cropReferenceLibraryPromise;
}

async function classifyCropWithLocalReferences(imageBuffer) {
    const references = await getCropReferenceLibrary();
    if (!references.length) return null;

    const targetSignature = await extractImageSignature(imageBuffer);
    const visualFeatures = await detectVisualCropFeatures(imageBuffer);
    const ranked = references
        .map((reference) => ({
            crop_name: reference.crop_name,
            file: reference.file,
            distance: signatureDistance(targetSignature, reference.signature)
        }))
        .sort((a, b) => a.distance - b.distance);

    const best = ranked[0];
    const second = ranked[1];
    if (!best) return null;

    const cottonKeywords = ['Cotton'];
    const grassKeywords = ['Millet', 'Paddy', 'Rice', 'Wheat', 'Maize', 'Sugarcane'];
    const bestIsGrass = grassKeywords.includes(best.crop_name);
    const bestIsCotton = cottonKeywords.includes(best.crop_name);
    const cottonCandidate = ranked.find((item) => cottonKeywords.includes(item.crop_name));

    if (
        visualFeatures.hasCottonLikeBolls
        && cottonCandidate
        && cottonCandidate.distance <= (best.distance + 0.45)
        && cottonCandidate.distance < 3.5
        && (!bestIsCotton || bestIsGrass)
    ) {
        if (cottonCandidate) {
            best.crop_name = cottonCandidate.crop_name;
            best.file = cottonCandidate.file;
            best.distance = Math.max(0, cottonCandidate.distance - 0.15);
        } else {
            best.crop_name = 'Cotton';
        }
    }

    const margin = second ? Math.max(0, second.distance - best.distance) : 0.18;
    let confidence = Math.max(40, Math.min(96, Math.round(92 - (best.distance * 35) + (margin * 18))));
    if (visualFeatures.hasCottonLikeBolls && best.crop_name === 'Cotton') {
        confidence = Math.max(confidence, 88);
    }
    if (visualFeatures.looksLikeGrassCrop && grassKeywords.includes(best.crop_name)) {
        confidence = Math.max(confidence, 82);
    }

    return {
        crop_name: best.crop_name,
        confidence,
        topMatches: ranked.slice(0, 3).map((item) => ({
            name: item.crop_name,
            confidence: `${Math.max(30, Math.min(96, Math.round(90 - (item.distance * 35))))}%`
        })),
        debug: {
            bestDistance: Number(best.distance.toFixed(4)),
            marginToSecond: Number(margin.toFixed(4)),
            referenceFile: best.file ? path.basename(best.file) : 'n/a'
        },
        visualFeatures
    };
}

async function callExternalCropAPI(imagePath, type = 'plantnet') {
    const apiKey = type === 'roboflow' ? process.env.ROBOFLOW_API_KEY : process.env.PLANTNET_API_KEY;
    if (!apiKey || apiKey.includes('your-') || apiKey.includes('dummy') || apiKey === '') {
        return null;
    }

    try {
        if (type === 'plantnet') {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('organs', 'leaf');
            form.append('images', fsModule.createReadStream(imagePath));
            
            const response = await fetch(`https://my-api.plantnet.org/v2/identify/all?api-key=${apiKey}`, {
                method: 'POST',
                body: form
            });
            
            if (!response.ok) return null;

            const data = await response.json();
            const bestMatch = data.results?.[0];
            if (bestMatch) {
                return {
                    crop_name: getReadableCropName(bestMatch.species.commonNames?.[0], bestMatch.species.scientificNameWithoutAuthor),
                    scientific_name: bestMatch.species.scientificNameWithoutAuthor,
                    confidence: Math.round(bestMatch.score * 100) + '%',
                    source: 'PlantNet Expert API'
                };
            }
        }

        if (type === 'perenual') {
            // Perenual Plant Identification
            const base64Image = fsModule.readFileSync(imagePath, { encoding: 'base64' });
            const response = await fetch(`https://perenual.com/api/plant-identification/v2/identify?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    images: [`data:image/jpeg;base64,${base64Image}`]
                })
            });

            if (!response.ok) {
                // Try fallback endpoint for identification
                const fallbackResponse = await fetch(`https://perenual.com/api/plant-identification?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        images: [`data:image/jpeg;base64,${base64Image}`]
                    })
                });
                if (!fallbackResponse.ok) return null;
                const data = await fallbackResponse.json();
                const bestMatch = data.data?.[0];
                if (bestMatch) {
                    return {
                        crop_name: getReadableCropName(bestMatch.common_name, bestMatch.scientific_name?.[0]),
                        scientific_name: bestMatch.scientific_name?.[0],
                        confidence: (bestMatch.probability * 100).toFixed(1) + '%',
                        source: 'Perenual Plant ID'
                    };
                }
            } else {
                const data = await response.json();
                const bestMatch = data.data?.[0];
                if (bestMatch) {
                    return {
                        crop_name: getReadableCropName(bestMatch.common_name, bestMatch.scientific_name?.[0]),
                        scientific_name: bestMatch.scientific_name?.[0],
                        confidence: (bestMatch.probability * 100).toFixed(1) + '%',
                        source: 'Perenual Plant ID'
                    };
                }
            }
        }
    } catch (e) {
    }
    return null;
}

function normalizeKindwiseList(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (!item) return '';
                if (typeof item === 'string') return item.trim();
                if (typeof item === 'object') {
                    return String(
                        item.name ||
                        item.common_name ||
                        item.description ||
                        item.text ||
                        item.title ||
                        ''
                    ).trim();
                }
                return String(item).trim();
            })
            .filter(Boolean);
    }

    if (typeof value === 'string') {
        return value.split(/\n|;|,/).map((item) => item.trim()).filter(Boolean);
    }

    if (value && typeof value === 'object') {
        return Object.values(value).map((item) => String(item || '').trim()).filter(Boolean);
    }

    return [];
}

function normalizeCropLabel(value) {
    return String(value || '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

const scientificCropNameMap = {
    'gossypium': 'Cotton',
    'gossypium hirsutum': 'Cotton',
    'gossypium herbaceum': 'Cotton',
    'oryza sativa': 'Paddy',
    'oryza spp': 'Paddy',
    'zea mays': 'Maize',
    'triticum aestivum': 'Wheat',
    'glycine max': 'Soybean',
    'solanum lycopersicum': 'Tomato',
    'solanum tuberosum': 'Potato',
    'allium cepa': 'Onion',
    'capsicum annuum': 'Chilli',
    'saccharum officinarum': 'Sugarcane',
    'arachis hypogaea': 'Groundnut',
    'musa': 'Banana',
    'musa spp': 'Banana'
};

function getReadableCropName(...values) {
    for (const value of values) {
        const raw = String(value || '').trim();
        if (!raw) continue;

        const mapped = scientificCropNameMap[raw.toLowerCase()];
        if (mapped) return mapped;

        const normalized = normalizeCropLabel(raw);
        if (normalized) return normalized;
    }

    return '';
}

function normalizeConfidenceLabel(score) {
    const normalizedScore = Number(score) > 1 ? Number(score) / 100 : Number(score);
    const safeScore = Number.isFinite(normalizedScore) ? Math.max(0, Math.min(1, normalizedScore)) : 0;

    if (safeScore >= 0.75) return 'High';
    if (safeScore >= 0.4) return 'Medium';
    return 'Low';
}

function extractUploadedImage(req) {
    if (req.file) return req.file;
    const fileGroups = req.files || {};
    return fileGroups.image?.[0] || fileGroups.cropPhoto?.[0] || fileGroups.file?.[0] || null;
}

function toPercentString(score) {
    const normalizedScore = Number(score) > 1 ? Number(score) / 100 : Number(score);
    const safeScore = Number.isFinite(normalizedScore) ? Math.max(0, Math.min(1, normalizedScore)) : 0;
    return `${(safeScore * 100).toFixed(2)}%`;
}

function parsePlantIdCropResult(data) {
    const rawResponse = data?.result || data || {};
    const suggestionCandidates = [
        rawResponse?.classification?.suggestions,
        rawResponse?.result?.classification?.suggestions,
        rawResponse?.suggestions,
        data?.classification?.suggestions,
        data?.suggestions
    ];
    const suggestions = suggestionCandidates.find((item) => Array.isArray(item) && item.length) || [];
    const rankedSuggestions = suggestions
        .map((item) => {
            const probability = Number(item?.probability) || 0;
            const commonNames = normalizeKindwiseList(
                item?.common_names ||
                item?.plant_details?.common_names ||
                item?.details?.common_names ||
                item?.classification?.common_names
            );
            const scientificName = String(
                item?.scientific_name ||
                item?.scientificName ||
                item?.plant_name ||
                item?.plant?.name ||
                item?.plant_details?.scientific_name ||
                item?.details?.scientific_name ||
                ''
            ).trim();
            const classificationLabel = String(
                item?.label ||
                item?.name ||
                item?.classification?.label ||
                ''
            ).trim();
            const cropName = getReadableCropName(
                commonNames[0],
                scientificName,
                classificationLabel
            );

            return {
                cropName,
                confidenceScore: probability > 1 ? probability / 100 : probability,
                confidencePercent: toPercentString(probability),
                scientificName: scientificName ? normalizeCropLabel(scientificName) : '',
                commonNames,
                raw: item
            };
        })
        .filter((item) => item.cropName)
        .sort((a, b) => b.confidenceScore - a.confidenceScore);

    console.log('[PLANT.ID] API response:', JSON.stringify(data));
    console.log('[PLANT.ID] suggestions array:', JSON.stringify(suggestions));

    if (!rankedSuggestions.length) {
        return null;
    }

    const selectedSuggestion = rankedSuggestions[0];
    const confidence = normalizeConfidenceLabel(selectedSuggestion.confidenceScore);

    console.log('[PLANT.ID] selected top suggestion:', JSON.stringify(selectedSuggestion.raw));
    console.log('[PLANT.ID] selected crop_name:', selectedSuggestion.cropName);
    console.log('[PLANT.ID] confidence score:', selectedSuggestion.confidencePercent);

    return {
        crop_name: selectedSuggestion.cropName,
        confidence,
        confidence_score: selectedSuggestion.confidenceScore,
        confidence_percent: selectedSuggestion.confidencePercent,
        scientific_name: selectedSuggestion.scientificName,
        common_names: selectedSuggestion.commonNames
    };
}

function getNumericConfidence(item) {
    const rawScore =
        Number(item?.probability) ||
        Number(item?.confidence) ||
        Number(item?.score) ||
        Number(item?.similarity) ||
        Number(item?.accuracy) ||
        0;
    return rawScore > 1 ? rawScore / 100 : rawScore;
}

function extractKindwiseCropCandidates(source) {
    const candidates = [];
    const visited = new Set();
    const walk = (node, pathText = 'root') => {
        if (!node || typeof node !== 'object') return;
        if (visited.has(node)) return;
        visited.add(node);

        if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, `${pathText}[${index}]`));
            return;
        }

        const pathLower = pathText.toLowerCase();
        const label = normalizeCropLabel(
            node.crop_name ||
            node.common_name ||
            node.name ||
            node.label ||
            node.plant_name ||
            node.crop?.name ||
            node.crop?.common_name
        );
        const confidence = getNumericConfidence(node);
        const cropContextHint =
            pathLower.includes('crop') ||
            pathLower.includes('plant') ||
            pathLower.includes('class') ||
            pathLower.includes('suggest') ||
            pathLower.includes('prediction');

        if (label && cropContextHint) {
            candidates.push({
                name: label,
                confidence,
                path: pathText
            });
        }

        Object.entries(node).forEach(([key, value]) => {
            if (value && typeof value === 'object') walk(value, `${pathText}.${key}`);
        });
    };

    walk(source);
    return candidates
        .filter((item) => item.name)
        .sort((a, b) => b.confidence - a.confidence);
}

function getKindwiseField(source, paths = []) {
    for (const pathText of paths) {
        const segments = pathText.split('.');
        let current = source;
        let valid = true;
        for (const segment of segments) {
            if (current == null) {
                valid = false;
                break;
            }
            if (/^\d+$/.test(segment)) current = current[Number(segment)];
            else current = current[segment];
        }
        if (current !== undefined && current !== null && current !== '') return current;
    }
    return null;
}

function toConfidenceBucket(score) {
    if (score >= 0.8) return 'High';
    if (score >= 0.55) return 'Medium';
    return 'Low';
}

function parseKindwiseCropHealthResponse(data) {
    const result = data?.result || data || {};
    console.log('[KINDWISE] Raw response object:', JSON.stringify(result));
    const rawCropSuggestions =
        getKindwiseField(result, [
            'crop.suggestions',
            'classification.suggestions',
            'plant.suggestions',
            'crop_prediction.suggestions',
            'predictions.crop.suggestions'
        ]) || [];
    console.log('[KINDWISE] Crop suggestions raw array/object:', JSON.stringify(rawCropSuggestions));
    const pathCropCandidates = Array.isArray(rawCropSuggestions)
        ? rawCropSuggestions
            .map((item) => {
                if (!item) return null;
                const label = normalizeCropLabel(
                    item.name ||
                    item.common_name ||
                    item.crop_name ||
                    item.label ||
                    item.plant_name ||
                    item.crop?.name ||
                    item.crop?.common_name
                );
                const rawScore =
                    Number(item.probability) ||
                    Number(item.confidence) ||
                    Number(item.score) ||
                    Number(item.similarity) ||
                    0;
                const score = rawScore > 1 ? rawScore / 100 : rawScore;
                return label ? { label, score, raw: item, path: 'configured-paths' } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score)
        : [];
    const discoveredCropCandidates = extractKindwiseCropCandidates(result);
    const cropSuggestions = [...pathCropCandidates];
    for (const candidate of discoveredCropCandidates) {
        if (!cropSuggestions.some((item) => item.label === candidate.name && Math.abs((item.score || 0) - (candidate.confidence || 0)) < 0.0001)) {
            cropSuggestions.push({
                label: candidate.name,
                score: candidate.confidence,
                raw: null,
                path: candidate.path
            });
        }
    }
    cropSuggestions.sort((a, b) => b.score - a.score);
    const diseaseSuggestions =
        getKindwiseField(result, [
            'disease.suggestions',
            'diseases.suggestions',
            'health_assessment.disease_suggestions',
            'health_assessment.diseases',
            'health_assessment.suggestions',
            'predictions.disease.suggestions'
        ]) ||
        [];

    const cropSuggestion = cropSuggestions[0] || null;
    const topDisease = Array.isArray(diseaseSuggestions) ? diseaseSuggestions[0] : null;
    const bestCropLabel = String(
        getKindwiseField(result, [
            'crop.common_name',
            'crop.name',
            'crop_prediction.best_match',
            'classification.best_match',
            'plant.name'
        ]) || ''
    ).trim();

    const cropName = normalizeCropLabel(
        cropSuggestion?.label ||
        result.crop?.common_name ||
        result.crop?.name ||
        result.plant?.name ||
        result.classification?.name ||
        topDisease?.crop?.name ||
        topDisease?.crop?.common_name ||
        bestCropLabel ||
        ''
    );

    const rawProbability =
        Number(topDisease?.probability) ||
        Number(topDisease?.confidence) ||
        Number(cropSuggestion?.score) ||
        Number(result.is_healthy_probability) ||
        0.45;

    const probability = rawProbability > 1 ? rawProbability / 100 : rawProbability;
    const confidence = toConfidenceBucket(probability);
    const healthyThresholdHit =
        result.is_healthy === true ||
        String(result.health_status || '').trim().toLowerCase() === 'healthy' ||
        Number(result.is_healthy_probability || 0) >= 0.5;

    const diseaseName = String(
        topDisease?.name ||
        topDisease?.common_name ||
        topDisease?.disease_name ||
        topDisease?.disease?.name ||
        topDisease?.label ||
        ''
    ).trim();

    const symptoms = normalizeKindwiseList(
        topDisease?.details?.symptoms ||
        topDisease?.symptoms ||
        topDisease?.description?.symptoms ||
        result.symptoms ||
        result.health_assessment?.symptoms
    );

    const treatmentRaw =
        topDisease?.details?.treatment ||
        topDisease?.treatment ||
        topDisease?.details?.treatment?.chemical ||
        topDisease?.details?.treatment?.biological ||
        topDisease?.details?.treatment?.prevention ||
        topDisease?.description?.treatment;
    const preventionTips = normalizeKindwiseList(
        topDisease?.details?.treatment?.prevention ||
        topDisease?.prevention ||
        topDisease?.description?.prevention
    );
    const treatment = normalizeKindwiseList(treatmentRaw);
    const severityRaw = String(
        topDisease?.details?.severity ||
        topDisease?.severity ||
        result.disease_severity ||
        ''
    ).trim();
    const diseaseSeverity = severityRaw
        ? (severityRaw.charAt(0).toUpperCase() + severityRaw.slice(1).toLowerCase())
        : (topDisease ? (probability >= 0.8 ? 'Severe' : probability >= 0.6 ? 'Moderate' : 'Mild') : 'None');

    const diseaseDetected = !healthyThresholdHit && Boolean(diseaseName);
    const careTips = diseaseDetected
        ? [
            ...(treatment.length ? treatment.slice(0, 2) : []),
            ...(preventionTips.length ? preventionTips.slice(0, 2) : []),
            'Inspect nearby plants and remove badly affected leaves to reduce field spread.'
        ].filter(Boolean).slice(0, 5)
        : preventionTips.filter(Boolean).slice(0, 5);
    const analysisSummary = diseaseDetected
        ? `${cropName || 'This crop'} shows likely signs of ${diseaseName} with ${diseaseSeverity.toLowerCase()} severity. Visible field symptoms and the uploaded image suggest focused treatment and preventive action are needed.`
        : `${cropName || 'This crop'} appears healthy with no major disease signs detected in the uploaded image. Continue preventive care, balanced nutrition, and routine field monitoring to maintain plant health.`;
    const immediateAction = diseaseDetected
        ? (treatment[0] || preventionTips[0] || `Start crop-specific treatment for ${diseaseName} and monitor symptom spread over the next 3 to 5 days.`)
        : 'Maintain balanced irrigation, avoid waterlogging, and inspect the crop weekly for early disease or pest symptoms.';
    const harvestReady = getKindwiseField(result, [
        'harvest_ready',
        'growth.harvest_ready',
        'plant.harvest_ready'
    ]);

    console.log('[KINDWISE] All possible crop labels:', cropSuggestions.map((item) => item.label));
    console.log('[KINDWISE] Extracted crop candidates:', cropSuggestions.map((item) => ({
        label: item.label,
        score: Number(item.score || 0).toFixed(4),
        path: item.path || 'n/a'
    })));
    console.log('[KINDWISE] Selected crop candidate:', cropSuggestion ? {
        label: cropSuggestion.label,
        score: Number(cropSuggestion.score || 0).toFixed(4),
        path: cropSuggestion.path || 'n/a'
    } : null);
    console.log('[KINDWISE] Selected crop_name:', cropName || 'none');
    console.log('[KINDWISE] Selected disease result:', {
        diseaseDetected,
        diseaseName: diseaseDetected ? diseaseName : 'Healthy crop',
        severity: diseaseDetected ? diseaseSeverity : 'None'
    });

    return {
        crop_name: cropName || normalizeCropLabel(bestCropLabel),
        confidence,
        health_status: diseaseDetected ? 'Diseased' : 'Healthy',
        disease_detected: diseaseDetected ? 'Yes' : 'No',
        disease_name: diseaseDetected ? diseaseName : '',
        disease_severity: diseaseDetected ? diseaseSeverity : 'None',
        symptoms: diseaseDetected
            ? (symptoms.length ? symptoms : [])
            : [],
        treatment: diseaseDetected
            ? [...treatment, ...preventionTips].filter(Boolean).slice(0, 6)
            : [],
        care_tips: careTips.length ? careTips : [],
        immediate_action: immediateAction,
        harvest_ready: harvestReady === true ? 'Yes' : harvestReady === false ? 'No' : 'No',
        analysis_summary: analysisSummary,
        crop_candidates: cropSuggestions.slice(0, 3).map((item) => ({
            name: item.label,
            confidence: toConfidenceBucket(item.score)
        }))
    };
}



const requireAuth = (req, res, next) => {
    if (req.session.user || req.session.userId) {
        next();
    } else {
        res.status(401).json({ error: 'Please login to continue' });
    }
};

// --- AUTH & USER ROUTES (MongoDB based with Email Verification) ---

app.post('/api/signup', async (req, res) => {
    try {
        const { name, username, email, password, phone, address } = req.body;
        
        if (!name || !username || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        
        // 1. Store user in database (MongoDB)
        let existingUser;
        try {
            existingUser = await User.findOne({ 
                $or: [{ email: normalizedEmail }, { username }] 
            });
        } catch (dbErr) {
            console.error('[AUTH] DB Check failed:', dbErr.message);
            return res.status(500).json({ error: 'Database error during registration check.' });
        }

        if (existingUser) {
            if (String(existingUser.email).toLowerCase() === normalizedEmail) {
                return res.status(400).json({ error: 'Email address is already in use' });
            } else {
                return res.status(400).json({ error: 'Username is already taken' });
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        // 2. Generate secure verification token using crypto
        const verificationToken = crypto.randomBytes(32).toString('hex');

        // Create new user in DB
        const user = new User({
            name,
            username,
            email: normalizedEmail,
            password: hashedPassword,
            phone: phone || '',
            location: address || '',
            verificationToken: verificationToken,
            isVerified: false,
            role: 'farmer'
        });
        
        await user.save();

        // Email Sending (Gmail via Nodemailer)
        const baseUrl = getAppBaseUrl(req);
        const verifyLink = `${baseUrl}/verify.html?token=${verificationToken}`;

        let emailSent = false;
        try {
            if (emailTransporter) {
                await sendBrandedEmail({
                    to: normalizedEmail,
                    subject: VERIFICATION_EMAIL_SUBJECT,
                    html: buildVerificationEmailHtml(verifyLink, name)
                });
                emailSent = true;
                console.log(`[AUTH] Verification email sent to ${normalizedEmail}`);
            }
        } catch (emailErr) {
            console.error('[AUTH] Failed to send verification email:', emailErr.message);
        }

        res.status(201).json({
            message: emailSent
                ? 'Account created! Please check your inbox to verify your email.'
                : 'Account created! (Email delivery is currently unavailable — contact support to verify.)',
            user: { email: normalizedEmail, name },
            emailSent
        });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Verification Route (frontend calls GET /verify/:token via API)
app.get('/verify/:token', async (req, res) => {
    try {
        const { token } = req.params;

        const user = await findUserByVerificationToken(token);

        if (!user) {
            return res.status(400).json({ error: 'Invalid or expired verification link', message: 'The verification link is invalid or has expired.' });
        }

        if (user.isVerified) {
            return res.status(200).json({
                message: 'Email already verified. You can log in now.',
                alreadyVerified: true
            });
        }

        // Keep the token so the same email link remains idempotent if reopened.
        // A resend will replace the token with a fresh one automatically.
        user.isVerified = true;
        await user.save();

        res.status(200).json({ message: 'Email verified successfully.' });
    } catch (err) {
        console.error('[AUTH] Verification Error:', err);
        res.status(500).json({ error: 'Server error during verification' });
    }
});

// Resend Verification Email Feature
app.post('/api/resend-verification', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const normalizedEmail = String(email).trim().toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });

        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.isVerified) return res.status(400).json({ error: 'Email is already verified' });

        // Generate new token
        const verificationToken = crypto.randomBytes(32).toString('hex');
        user.verificationToken = verificationToken;
        await user.save();

        const baseUrl = getAppBaseUrl(req);
        const verifyLink = `${baseUrl}/verify.html?token=${verificationToken}`;

        if (emailTransporter) {
            await sendBrandedEmail({
                to: normalizedEmail,
                subject: VERIFICATION_EMAIL_SUBJECT,
                replyTo: getSupportEmail(),
                html: buildVerificationEmailHtml(verifyLink, user.name || user.username || '')
            });
            res.json({ message: 'Verification email resent successfully' });
        } else {
            res.status(503).json({
                error: 'Email service is not configured. Set SMTP_AUTH_USER/SMTP_AUTH_PASS or EMAIL_USER/EMAIL_PASS.'
            });
        }
    } catch (err) {
        console.error('[AUTH] Resend Verification Error:', err);
        const isAuthError = err && (
            err.code === 'EAUTH' ||
            err.responseCode === 535 ||
            /invalid login|username and password not accepted|authentication/i.test(String(err.message || ''))
        );

        if (isAuthError) {
            return res.status(503).json({
                error: 'SMTP authentication failed for the configured mailbox. Update EMAIL_PASS for support.cropai@gmail.com, or set SMTP_AUTH_USER/SMTP_AUTH_PASS separately.'
            });
        }

        res.status(500).json({ error: 'Failed to resend email' });
    }
});


app.post('/api/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        const normalizedIdentifier = String(identifier).trim().toLowerCase();
        
        const user = await User.findOne({ 
            $or: [{ email: normalizedIdentifier }, { username: identifier }] 
        });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (!user.isVerified) {
            return res.status(403).json({ error: 'Please verify your email first' });
        }

        req.session.userId = user._id.toString();
        req.session.loginIdentifier = identifier;
        req.session.user = { id: user._id.toString(), name: user.name, username: user.username, email: user.email, avatar: user.avatar };
        res.json({ message: 'Login successful', user: req.session.user });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed', details: err.message });
    }
});

// Google authentication endpoint
app.post('/api/auth/google', async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({ error: 'ID token is required' });
        }

        // Verify the Google ID token
        const ticket = await googleClient.verifyIdToken({
            idToken: idToken,
            audience: GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const { email, name, picture, sub: googleId } = payload;

        // Find or create user
        let user = await User.findOne({ email: email });
        if (!user) {
            // Create new user if doesn't exist
            const newUser = {
                id: Date.now().toString(),
                email: email,
                name: name,
                username: email.split('@')[0], // Use email prefix as username
                password: '', // No password for Google users
                avatar: picture || '',
                provider: 'google',
                googleId: googleId,
                createdAt: new Date().toISOString()
            };
            user = await new User(newUser).save();
        }

        // Create session
        req.session.userId = user.id;
        req.session.user = { 
            id: user.id, 
            name: user.name, 
            username: user.username, 
            email: user.email, 
            avatar: user.avatar || picture 
        };

        res.json({ 
            message: 'Google login successful', 
            user: req.session.user 
        });
    } catch (err) {
        console.error('Google auth error:', err);
        res.status(401).json({ error: 'Google authentication failed', details: err.message });
    }
});

// Social authentication endpoint (for demo mode)
app.post('/api/auth/social', async (req, res) => {
    try {
        const { provider, email, name, photoURL, uid } = req.body;
        
        if (!provider || !email || !name) {
            return res.status(400).json({ error: 'Provider, email, and name are required' });
        }

        // Find or create user
        let user = await User.findOne({ email: email });
        if (!user) {
            // Create new user if doesn't exist
            const newUser = {
                id: uid || Date.now().toString(),
                email: email,
                name: name,
                username: email.split('@')[0],
                password: '',
                avatar: photoURL || '',
                provider: provider.toLowerCase(),
                createdAt: new Date().toISOString()
            };
            user = await new User(newUser).save();
        }

        // Create session
        req.session.userId = user.id;
        req.session.user = { 
            id: user.id, 
            name: user.name, 
            username: user.username, 
            email: user.email, 
            avatar: user.avatar || photoURL 
        };

        res.json({ 
            message: 'Social login successful', 
            user: req.session.user 
        });
    } catch (err) {
        console.error('Social auth error:', err);
        res.status(500).json({ error: 'Social authentication failed', details: err.message });
    }
});

app.post('/api/forgot-pass', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required.' });

        const user = await User.findOne({ email: email });
        if (!user) {
            return res.status(404).json({ error: 'User with this email not found.' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 3600000; // 1 hour

        resetTokenStore.set(token, { email, expiresAt });

        const resetLink = `${getAppBaseUrl(req)}/reset-password.html?token=${token}`;
        console.log(`[AUTH] Password reset requested for ${email}. Link: ${resetLink}`);

        if (emailMode === 'disabled' || !emailTransporter) {
            return res.json({ 
                message: `Email service offline. Use this link: ${resetLink} (Shown for testing purposes)`
            });
        }

        const mailOptions = {
            to: email,
            subject: 'Reset Your CropAI Password',
            html: `
                <div style="background-color: #050a06; font-family: 'Outfit', 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px; border-radius: 32px; color: #ffffff; text-align: center; border: 1px solid rgba(0, 255, 136, 0.1);">
                    <div style="margin-bottom: 30px;">
                        <div style="font-size: 60px; color: #00ff88; margin-bottom: 15px;">🌱</div>
                        <h1 style="color: #00ff88; margin: 0; font-size: 36px; font-weight: 900; letter-spacing: 2px;">CropAI</h1>
                        <p style="color: #00ff88; font-size: 14px; margin-top: 8px; opacity: 0.8; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;">PASSWORD RESET REQUEST</p>
                    </div>
                    
                    <div style="background: rgba(0, 255, 136, 0.03); border: 1px solid rgba(0, 255, 136, 0.08); border-radius: 20px; padding: 35px; text-align: left;">
                        <p style="font-size: 18px; margin-bottom: 20px; color: #ffffff;">Hi <span style="color: #00ff88; font-weight: 800;">${user.name || 'Farmer'}</span>,</p>
                        
                        <p style="color: #b0b0b0; line-height: 1.6; margin-bottom: 25px; font-size: 16px;">
                            We received a request to reset your password for your <span style="color: #ffffff; font-weight: bold;">CropAI</span> account. 
                            Click the button below to set a new password:
                        </p>
                        
                        <div style="text-align: center; margin: 40px 0;">
                            <a href="${resetLink}" style="background: linear-gradient(135deg, #00ff88 0%, #00d977 100%); color: #050a06; padding: 20px 45px; text-decoration: none; border-radius: 20px; font-weight: 900; font-size: 18px; display: inline-block; box-shadow: 0 10px 30px rgba(0, 255, 136, 0.25); border: none;">
                                🔐 Reset Your Password
                            </a>
                        </div>
                        
                        <div style="background-color: rgba(0, 242, 255, 0.08); border-left: 5px solid #00f2ff; padding: 20px; border-radius: 12px; margin-top: 35px;">
                            <p style="margin: 0; font-size: 15px; color: #00f2ff; font-weight: 600;">
                                ⚠️ <strong style="font-weight: 800;">Important:</strong> This link will expire in <span style="text-decoration: underline;">1 hour</span> for your security.
                            </p>
                        </div>
                        
                        <div style="margin-top: 40px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 25px; text-align: center;">
                            <p style="color: #555; font-size: 13px; margin-bottom: 0;">
                                If you didn't request this, please ignore this email. No changes will be made to your account.
                            </p>
                        </div>
                    </div>
                    
                    <div style="margin-top: 35px; color: #333; font-size: 11px; font-weight: 600; letter-spacing: 0.5px;">
                        &copy; 2026 CropAI Technologies PVT LTD. All rights reserved.
                    </div>
                </div>
            `
        };

        await sendBrandedEmail(mailOptions);
        res.json({ message: 'A reset link has been sent to your email address.' });
    } catch (err) {
        console.error('Forgot pass error:', err);
        res.status(500).json({ error: 'Failed to process request.' });
    }
});

app.post('/api/reset-pass', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) return res.status(400).json({ error: 'All fields are required.' });

        const resetData = resetTokenStore.get(token);
        if (!resetData || resetData.expiresAt < Date.now()) {
            return res.status(400).json({ error: 'Invalid or expired token.' });
        }

        const user = await User.findOne({ email: resetData.email });
        if (!user) return res.status(404).json({ error: 'User no longer exists.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        await User.findByIdAndUpdate(user.id, { password: hashedPassword }, { new: true });
        
        resetTokenStore.delete(token);

        res.json({ message: 'Password reset successful! Redirecting...' });
    } catch (err) {
        console.error('Reset pass error:', err);
        res.status(500).json({ error: 'Failed to reset password.' });
    }
});

// Google configuration endpoint
app.get('/api/config/google', (req, res) => {
    res.json({ 
        clientId: GOOGLE_CLIENT_ID 
    });
});

// Firebase configuration endpoint (Dummy for now to prevent 404s)
app.get('/api/config/firebase', (req, res) => {
    res.json({
        apiKey: process.env.FIREBASE_API_KEY || "dummy-api-key",
        authDomain: process.env.FIREBASE_AUTH_DOMAIN || "crop-ai-demo.firebaseapp.com",
        projectId: process.env.FIREBASE_PROJECT_ID || "crop-ai-demo",
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "crop-ai-demo.appspot.com",
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "123456789",
        appId: process.env.FIREBASE_APP_ID || "1:123456:web:abcd"
    });
});


app.get('/api/user', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        let safeUser = buildSafeUserResponse(user);
        safeUser.loginIdentifier = req.session.loginIdentifier || safeUser.username || safeUser.email || '';
        res.json({ user: safeUser });
    } catch(e) {
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

app.put('/api/user', requireAuth, async (req, res) => {
    try {
        const existingUser = await User.findById(req.session.userId);
        if (!existingUser) return res.status(404).json({ error: 'User not found' });

        const updates = sanitizeUserProfilePayload(req.body, existingUser);
        const updatedUser = await User.findByIdAndUpdate(req.session.userId, updates, { new: true });
        if (!updatedUser) return res.status(404).json({ error: 'User not found' });
        const safeUser = buildSafeUserResponse(updatedUser);
        res.json({ user: safeUser });
    } catch (err) {
        res.status(500).json({ error: 'Update failed' });
    }
});

app.post('/api/user/selected-crops', requireAuth, async (req, res) => {
    try {
        const cropName = String(req.body?.crop || '').trim();
        const normalizedCrop = normalizeCropIdentity(cropName);
        if (!normalizedCrop) {
            return res.status(400).json({ error: 'A valid crop selection is required' });
        }

        const user = await User.findById(req.session.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const safeUser = user.toObject ? user.toObject() : JSON.parse(JSON.stringify(user));
        const currentSelections = Array.isArray(safeUser.selectedCrops) ? safeUser.selectedCrops : [];
        const alreadyExists = currentSelections.some((entry) => normalizeCropIdentity(entry?.crop) === normalizedCrop);

        if (!alreadyExists) {
            const selectionContext = req.body?.selectionContext && typeof req.body.selectionContext === 'object'
                ? req.body.selectionContext
                : {};
            const recommendationSnapshot = req.body?.recommendationSnapshot && typeof req.body.recommendationSnapshot === 'object'
                ? req.body.recommendationSnapshot
                : {};

            currentSelections.push({
                id: `crop_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
                crop: cropName,
                selectedAt: new Date().toISOString(),
                recommendationSnapshot,
                selectionContext: {
                    ...selectionContext,
                    farmSize: Number(selectionContext.farmSize) || Number(safeUser.farmSize) || null,
                    location: selectionContext.location || safeUser.location || safeUser.address || ''
                }
            });
        }

        const updates = {
            selectedCrops: currentSelections,
            preferredCrops: buildPreferredCropText(currentSelections, safeUser.preferredCrops)
        };

        const updatedUser = await User.findByIdAndUpdate(req.session.userId, updates, { new: true });
        if (!updatedUser) return res.status(404).json({ error: 'User not found' });

        res.json({
            saved: !alreadyExists,
            duplicate: alreadyExists,
            user: buildSafeUserResponse(updatedUser)
        });
    } catch (error) {
        console.error('Failed to save selected crop:', error);
        res.status(500).json({ error: 'Failed to save selected crop' });
    }
});

app.delete('/api/remove-crop/:cropId', requireAuth, async (req, res) => {
    try {
        const cropId = String(req.params.cropId || '').trim();
        if (!cropId) {
            return res.status(400).json({ error: 'A valid crop ID is required' });
        }

        const user = await User.findById(req.session.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const safeUser = user.toObject ? user.toObject() : JSON.parse(JSON.stringify(user));
        const currentSelections = Array.isArray(safeUser.selectedCrops) ? safeUser.selectedCrops : [];
        const nextSelections = currentSelections.filter((entry) => buildCropSelectionId(entry) !== cropId);

        if (nextSelections.length === currentSelections.length) {
            return res.status(404).json({ error: 'Crop not found' });
        }

        const updates = {
            selectedCrops: nextSelections,
            preferredCrops: buildPreferredCropText(nextSelections, safeUser.preferredCrops)
        };

        const updatedUser = await User.findByIdAndUpdate(req.session.userId, updates, { new: true });
        if (!updatedUser) return res.status(404).json({ error: 'User not found' });

        res.json({
            removed: true,
            cropId,
            user: buildSafeUserResponse(updatedUser)
        });
    } catch (error) {
        console.error('Failed to remove selected crop:', error);
        res.status(500).json({ error: 'Failed to remove selected crop' });
    }
});

app.post('/api/user/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const avatarUrl = `/uploads/${req.file.filename}`;
        await User.findByIdAndUpdate(req.session.userId, { avatar: avatarUrl }, { new: true });
        res.json({ avatarUrl });
    } catch (err) {
        res.status(500).json({ error: 'Avatar upload failed' });
    }
});

app.all('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: 'Logged out' });
});

// --- END AUTH & USER ROUTES ---

function buildCropHealthSummary(cropName, healthResult) {
    const diseaseDetected = String(healthResult?.disease_detected || '').trim().toLowerCase() === 'yes';
    const diseaseName = String(healthResult?.disease_name || '').trim();
    const severity = String(healthResult?.disease_severity || '').trim().toLowerCase();

    if (diseaseDetected) {
        return `${cropName} shows signs of ${diseaseName || 'a crop health issue'}${severity ? ` with ${severity} severity` : ''}. Review the symptoms and start the recommended treatment promptly.`;
    }

    return `${cropName} appears healthy in the uploaded image. Continue preventive care, balanced irrigation, and routine monitoring to keep the crop in good condition.`;
}

function ensureMeaningfulImmediateAction(action, diseaseDetected, diseaseName, cropName) {
    const normalized = String(action || '').trim();
    if (normalized && !['low', 'medium', 'high'].includes(normalized.toLowerCase())) {
        return normalized.endsWith('.') ? normalized : `${normalized}.`;
    }

    if (String(diseaseDetected || '').toLowerCase() === 'yes') {
        return `Inspect ${cropName} closely, isolate severely affected leaves, and begin treatment for ${diseaseName || 'the detected disease'} immediately.`;
    }

    return `Continue monitoring ${cropName} regularly, maintain balanced irrigation, and inspect leaves weekly for early disease symptoms.`;
}

async function callPlantIdIdentification(uploadedImage, base64Image) {
    console.log('[PLANT.ID] API called:', {
        endpoint: externalApiConfig.plantId.apiUrl,
        fileName: uploadedImage.originalname,
        mimeType: uploadedImage.mimetype,
        fileSize: uploadedImage.size
    });

    const apiResponse = await requestPlantIdIdentification({ base64Image });
    const parsedResult = parsePlantIdCropResult(apiResponse);
    if (!parsedResult || !parsedResult.crop_name) {
        throw new Error('Plant.id did not return a valid crop suggestion.');
    }

    return parsedResult;
}

async function callCropHealthAnalysis(uploadedImage, base64Image) {
    console.log('[PLANT.HEALTH] API called:', {
        endpoint: externalApiConfig.cropHealth.apiUrl,
        fileName: uploadedImage.originalname,
        mimeType: uploadedImage.mimetype,
        fileSize: uploadedImage.size
    });

    const apiResponse = await requestCropHealthIdentification({ base64Image });
    console.log('[PLANT.HEALTH] raw response:', JSON.stringify(apiResponse));
    return parseKindwiseCropHealthResponse(apiResponse);
}

function buildFallbackCropHealthResult(cropName, confidence) {
    return {
        crop_name: cropName,
        confidence: confidence || 'Medium',
        health_status: 'Healthy',
        disease_detected: 'No',
        disease_name: '',
        disease_severity: 'None',
        symptoms: [],
        treatment: [],
        care_tips: [
            `Continue routine monitoring for ${cropName}.`,
            'Maintain balanced irrigation and good airflow around the crop.',
            'Upload a closer leaf photo if you want a more detailed disease analysis.'
        ],
        immediate_action: ensureMeaningfulImmediateAction('', 'No', '', cropName),
        harvest_ready: 'No'
    };
}

async function handleCombinedCropAnalysis(req, res) {
    try {
        const uploadedImage = extractUploadedImage(req);
        if (!uploadedImage) {
            return res.status(400).json({
                success: false,
                error: 'No crop image uploaded. Use multipart/form-data with the field name "cropPhoto".'
            });
        }

        if (!allowedImageMimeTypes.has(uploadedImage.mimetype)) {
            return res.status(400).json({
                success: false,
                error: `Unsupported image format: ${uploadedImage.mimetype}. Please upload JPEG, PNG, WEBP, HEIC, or HEIF.`
            });
        }

        if (!uploadedImage.buffer || !uploadedImage.buffer.length) {
            return res.status(400).json({
                success: false,
                error: 'Uploaded image is empty.'
            });
        }

        let normalizedBuffer = uploadedImage.buffer;
        let normalizedMimeType = uploadedImage.mimetype;
        try {
            normalizedBuffer = await sharp(uploadedImage.buffer)
                .rotate()
                .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90 })
                .toBuffer();
            normalizedMimeType = 'image/jpeg';
        } catch (imagePrepError) {
            console.warn('[CROP.ANALYSIS] Image normalization failed, using original upload:', imagePrepError.message);
        }

        const base64Image = normalizedBuffer.toString('base64');
        console.log('[CROP.ANALYSIS] prepared image payload:', {
            fileName: uploadedImage.originalname,
            originalMimeType: uploadedImage.mimetype,
            normalizedMimeType,
            originalBytes: uploadedImage.buffer.length,
            normalizedBytes: normalizedBuffer.length
        });

        const [plantIdOutcome, cropHealthOutcome] = await Promise.allSettled([
            callPlantIdIdentification(uploadedImage, base64Image),
            callCropHealthAnalysis(uploadedImage, base64Image)
        ]);

        const plantIdResult = plantIdOutcome.status === 'fulfilled' ? plantIdOutcome.value : null;
        const cropHealthResult = cropHealthOutcome.status === 'fulfilled' ? cropHealthOutcome.value : null;
        const primaryError = plantIdOutcome.status === 'rejected'
            ? plantIdOutcome.reason
            : (cropHealthOutcome.status === 'rejected' ? cropHealthOutcome.reason : null);

        if (!plantIdResult && !cropHealthResult) {
            throw primaryError || new Error('Crop analysis failed for all providers.');
        }

        if (plantIdOutcome.status === 'rejected') {
            console.warn('[CROP.ANALYSIS] Plant identification degraded:', plantIdOutcome.reason?.message || plantIdOutcome.reason);
        }

        if (cropHealthOutcome.status === 'rejected') {
            console.warn('[CROP.ANALYSIS] Crop health analysis degraded:', cropHealthOutcome.reason?.message || cropHealthOutcome.reason);
        }

        const cropName = plantIdResult?.crop_name || cropHealthResult?.crop_name || 'Detected crop';
        const mergedHealthResult = cropHealthResult || buildFallbackCropHealthResult(
            cropName,
            plantIdResult?.confidence
        );
        const finalPayload = {
            crop_name: cropName,
            confidence: mergedHealthResult.confidence || plantIdResult?.confidence || 'Medium',
            health_status: mergedHealthResult.health_status || 'Healthy',
            disease_detected: mergedHealthResult.disease_detected || 'No',
            disease_name: mergedHealthResult.disease_name || '',
            disease_severity: mergedHealthResult.disease_severity || 'None',
            symptoms: Array.isArray(mergedHealthResult.symptoms) ? mergedHealthResult.symptoms : [],
            treatment: Array.isArray(mergedHealthResult.treatment) ? mergedHealthResult.treatment : [],
            care_tips: Array.isArray(mergedHealthResult.care_tips) ? mergedHealthResult.care_tips : [],
            immediate_action: ensureMeaningfulImmediateAction(
                mergedHealthResult.immediate_action,
                mergedHealthResult.disease_detected,
                mergedHealthResult.disease_name,
                cropName
            ),
            harvest_ready: mergedHealthResult.harvest_ready || 'No',
            analysis_summary: buildCropHealthSummary(cropName, mergedHealthResult),
            degraded: plantIdOutcome.status === 'rejected' || cropHealthOutcome.status === 'rejected',
            warnings: [
                plantIdOutcome.status === 'rejected' ? 'Plant identification provider was unavailable, so a fallback result was used.' : null,
                cropHealthOutcome.status === 'rejected' ? 'Detailed crop health analysis was unavailable, so a basic health response was used.' : null
            ].filter(Boolean)
        };

        console.log('[CROP.ANALYSIS] final crop_name before response:', cropName);
        console.log('[CROP.ANALYSIS] final merged JSON sent to frontend:', JSON.stringify(finalPayload));

        return res.json({
            success: true,
            analysis: finalPayload
        });
    } catch (error) {
        console.error('[CROP.ANALYSIS] Combined analysis failed:', error.message);
        console.error('[CROP.ANALYSIS] Axios status:', error.response?.status || null);
        console.error('[CROP.ANALYSIS] Axios data:', JSON.stringify(error.response?.data || null));
        if (error.response) {
            console.error('[CROP.ANALYSIS] API error response:', JSON.stringify(error.response.data));
        }
        const mappedError = mapExternalApiError(error, 'Unable to analyze the uploaded crop image right now.');
        return res.status(mappedError.status).json(mappedError.body);
    }
}

app.post('/api/analyze-photo', analyzeCropUpload.single('cropPhoto'), handleCombinedCropAnalysis);
app.post('/api/analyze-crop', analyzeCropUpload.single('cropPhoto'), handleCombinedCropAnalysis);
app.post('/api/upload-photo', analyzeCropUpload.single('cropPhoto'), handleCombinedCropAnalysis);

// Clean URL route for crop images - avoids all space/encoding issues in folder name
// Frontend uses /crop-images/filename instead of /images/Crop%20images/filename
app.use('/crop-images', express.static(path.join(frontendDir, 'images', 'Crop_images'), {
    etag: true,
    lastModified: true,
    setHeaders(res) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
}));

// Serve static files from the frontend directory
app.use(express.static(frontendDir, {
    etag: false,
    lastModified: false,
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Explicit route for the home page (index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        uptime: Math.round(process.uptime()),
        environment: process.env.NODE_ENV || 'development',
        database: isMongoConnected ? 'mongodb' : 'json-fallback'
    });
});



app.post('/api/soil-analysis', (req, res) => {
    try {
        const { n, p, k, ph, oc, ec, lang = 'en' } = req.body || {};
        const isTa = lang === 'ta';
        const n_val = parseFloat(n) || 0, p_val = parseFloat(p) || 0, k_val = parseFloat(k) || 0;
        const ph_val = parseFloat(ph) || 7.0, oc_val = parseFloat(oc) || 0.5, ec_val = parseFloat(ec) || 0.5;

        let score = 70;
        const nutrients = [
            { label: isTa ? 'தழைச்சத்து (Nitrogen)' : 'Nitrogen (N)', value: n_val, unit: 'mg/kg', percent: Math.min((n_val / 400) * 100, 100), color: 'primary' },
            { label: isTa ? 'மணிச்சத்து (Phosphorus)' : 'Phosphorus (P)', value: p_val, unit: 'mg/kg', percent: Math.min((p_val / 50) * 100, 100), color: 'info' },
            { label: isTa ? 'சாம்பல்சத்து (Potassium)' : 'Potassium (K)', value: k_val, unit: 'mg/kg', percent: Math.min((k_val / 500) * 100, 100), color: 'warning' }
        ];

        nutrients.forEach(nt => {
            if (nt.percent < 30) nt.level = isTa ? 'குறைவு' : 'Low';
            else if (nt.percent > 75) nt.level = isTa ? 'அதிகம்' : 'High';
            else nt.level = isTa ? 'சரியான அளவு' : 'Optimal';
            if (nt.level !== (isTa ? 'சரியான அளவு' : 'Optimal')) score -= 10;
        });

        if (ph_val < 6.0 || ph_val > 8.0) score -= 15;
        if (oc_val < 0.5) score -= 10; else score += 5;
        score = Math.max(Math.min(score, 100), 10);

        const insights = [
            {
                title: isTa ? 'pH மேலாண்மை' : 'pH Management',
                text: ph_val < 6.0 ? (isTa ? 'மண்ணின் அமிலத்தன்மையைக் குறைக்க சுண்ணாம்பு (Lime) சேர்க்கவும்.' : 'Apply Lime to reduce soil acidity.') :
                    ph_val > 8.0 ? (isTa ? 'மண்ணின் காரத்தன்மையைக் குறைக்க ஜிப்சம் (Gypsum) சேர்க்கவும்.' : 'Apply Gypsum to reduce alkalinity.') :
                        (isTa ? 'மண்ணின் pH சரியான நிலையில் உள்ளது.' : 'pH is optimal.'),
                icon: 'fa-vial', color: 'primary'
            },
            {
                title: isTa ? 'ஊட்டச்சத்து திருத்தம்' : 'Nutrient Correction',
                text: n_val < 150 ? (isTa ? 'தழைச்சத்து குறைவாக உள்ளது.' : 'Nitrogen is low.') : 'Levels are satisfactory.',
                icon: 'fa-capsules', color: 'info'
            },
            {
                title: isTa ? 'கரிமப் பொருள்' : 'Organic Matter',
                text: oc_val < 0.6 ? (isTa ? 'கரிம கார்பன் குறைவாக உள்ளது.' : 'Organic carbon is low.') : 'Sufficient organic matter.',
                icon: 'fa-leaf', color: 'success'
            }
        ];

        res.json({
            score, nutrients, insights,
            status: score > 80 ? (isTa ? 'மிக நன்று' : 'Excellent') : (isTa ? 'நன்று' : 'Good'),
            statusColor: score > 80 ? 'success' : 'primary'
        });
    } catch (e) { res.status(500).json({ error: 'Soil error' }); }
});

app.post('/api/debug/analyze-crop-health-only', analyzeCropUpload.single('cropPhoto'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No crop image uploaded. Use multipart/form-data with the field name "cropPhoto".'
            });
        }

        console.log('[KINDWISE] Uploaded file received:', {
            fieldname: req.file.fieldname,
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            hasBuffer: Boolean(req.file.buffer),
            bufferBytes: req.file.buffer?.length || 0
        });

        const allowedMimeTypes = [
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/webp',
            'image/heic',
            'image/heif'
        ];

        if (!allowedMimeTypes.includes(req.file.mimetype)) {
            return res.status(400).json({
                success: false,
                error: `Unsupported image format: ${req.file.mimetype}. Please upload JPEG, PNG, WEBP, HEIC, or HEIF.`
            });
        }

        if (req.file.size < 5000) {
            return res.status(400).json({
                success: false,
                error: `Uploaded image is too small (${req.file.size} bytes). Please use a real crop photo with more visible detail.`
            });
        }

        const originalBuffer = req.file.buffer;
        let normalizedBuffer = originalBuffer;
        let normalizedMimeType = req.file.mimetype;
        try {
            normalizedBuffer = await sharp(originalBuffer)
                .rotate()
                .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90 })
                .toBuffer();
            normalizedMimeType = 'image/jpeg';
        } catch (imagePrepError) {
            console.warn('[KINDWISE] Image normalization failed, using original upload:', imagePrepError.message);
        }

        const imageBase64 = normalizedBuffer.toString('base64');
        console.log('[KINDWISE] Analyze request prepared:', {
            fileName: req.file.originalname,
            mimeType: req.file.mimetype,
            normalizedMimeType,
            originalBytes: originalBuffer.length,
            normalizedBytes: normalizedBuffer.length,
            base64Length: imageBase64.length
        });
        console.log('[KINDWISE] Request URL:', externalApiConfig.cropHealth.apiUrl);
        console.log('[KINDWISE] Request payload summary:', {
            imageCount: 1,
            firstImageLength: imageBase64.length,
            latitude: 11.6643,
            longitude: 78.1460
        });

        const apiResponse = await requestCropHealthIdentification({ base64Image: imageBase64 });
        console.log('RAW API RESPONSE:', JSON.stringify(apiResponse));

        const parsed = parseKindwiseCropHealthResponse(apiResponse);
        const finalPayload = {
            crop_name: parsed.crop_name,
            confidence: parsed.confidence,
            health_status: parsed.health_status,
            disease_detected: parsed.disease_detected,
            disease_name: parsed.disease_name,
            disease_severity: parsed.disease_severity,
            symptoms: parsed.symptoms,
            treatment: parsed.treatment,
            care_tips: parsed.care_tips,
            immediate_action: parsed.immediate_action,
            harvest_ready: parsed.harvest_ready,
            analysis_summary: parsed.analysis_summary,
            crop_candidates: parsed.crop_candidates
        };

        console.log('[KINDWISE] Final JSON sent to frontend:', finalPayload);

        return res.json({
            success: true,
            ...finalPayload
        });
    } catch (error) {
        console.error('[KINDWISE] Crop analysis failed:', error.message);
        console.error('[KINDWISE] Request URL:', externalApiConfig.cropHealth.apiUrl || 'missing');
        console.error('[KINDWISE] Axios status:', error.response?.status || null);
        console.error('[KINDWISE] Axios data:', JSON.stringify(error.response?.data || null));
        if (error.response) {
            console.error('[KINDWISE] API status:', error.response.status);
            console.error('[KINDWISE] API headers:', JSON.stringify(error.response.headers || {}));
            console.error('[KINDWISE] API error body:', JSON.stringify(error.response.data));
        }
        console.error('[KINDWISE] Last request summary:', {
            hasApiKey: Boolean(externalApiConfig.cropHealth.apiKey),
            fileName: req.file?.originalname || null,
            mimeType: req.file?.mimetype || null,
            fileSize: req.file?.size || null,
            hasBuffer: Boolean(req.file?.buffer),
            bufferBytes: req.file?.buffer?.length || null
        });
        const backendReason =
            error.response?.data?.detail ||
            error.response?.data?.message ||
            error.response?.data?.error ||
            error.message;
        console.error('[KINDWISE] Backend reason:', backendReason);
        const mappedError = mapExternalApiError(error, 'Unable to analyze crop image right now.');
        return res.status(mappedError.status).json(mappedError.body);
    }
});

app.post('/api/detect-crop', (req, res, next) => {
    detectCropUpload(req, res, (error) => {
        if (error) return next(error);
        return next();
    });
}, async (req, res) => {
    const uploadedImage = extractUploadedImage(req);

    try {
        if (!uploadedImage) {
            return res.status(400).json({ success: false, error: 'Image upload is required. Use image, cropPhoto, or file as the form-data field.' });
        }

        if (!allowedImageMimeTypes.has(uploadedImage.mimetype)) {
            return res.status(400).json({ success: false, error: 'Unsupported file type. Please upload JPEG, PNG, WEBP, HEIC, or HEIF.' });
        }

        if (!uploadedImage.buffer || !uploadedImage.buffer.length) {
            return res.status(400).json({ success: false, error: 'Uploaded image is empty.' });
        }

        const base64Image = uploadedImage.buffer.toString('base64');
        const apiResponse = await requestPlantIdIdentification({ base64Image });

        const parsedResult = parsePlantIdCropResult(apiResponse);
        if (!parsedResult) {
            return res.status(422).json({ success: false, error: 'No crop suggestion returned by Plant.id for this image.' });
        }

        return res.json(parsedResult);
    } catch (error) {
        console.error('[PLANT.ID] Crop detection failed:', error.message);
        console.error('[PLANT.ID] Axios status:', error.response?.status || null);
        console.error('[PLANT.ID] Axios data:', JSON.stringify(error.response?.data || null));
        if (error.response) {
            console.error('[PLANT.ID] API error response:', JSON.stringify(error.response.data));
        }

        const mappedError = mapExternalApiError(error, 'Unable to detect crop right now.');
        return res.status(mappedError.status).json(mappedError.body);
    }
});

app.post('/api/upload-photo', upload.single('cropPhoto'), async (req, res) => {
    try {
        if (!req.file) {
            console.error('[PHOTO] No file received by multer for field "cropPhoto".');
            return res.status(400).json({ status: 'failed', message: 'No photo uploaded.', debug: { expectedField: 'cropPhoto' } });
        }

        console.log('[PHOTO] Upload received:', {
            fieldname: req.file.fieldname,
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            path: req.file.path,
            filename: req.file.filename
        });

        const allowedMimeTypes = [
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/webp',
            'image/heic',
            'image/heif'
        ];
        if (!allowedMimeTypes.includes(req.file.mimetype)) {
            if (req.file && fsModule.existsSync(req.file.path)) fsModule.unlinkSync(req.file.path);
            return res.status(400).json({ status: 'failed', message: 'Unsupported format. Please upload JPEG, PNG, WEBP, HEIC, or HEIF.', debug: { mimetype: req.file.mimetype } });
        }
        if (req.file.size < 5000) {
            if (req.file && fsModule.existsSync(req.file.path)) fsModule.unlinkSync(req.file.path);
            return res.status(400).json({ status: 'failed', message: 'Low quality. Please upload a clearer crop image.', debug: { size: req.file.size } });
        }

        const originalBuffer = fsModule.readFileSync(req.file.path);
        let analysisBuffer = originalBuffer;
        let analysisMimeType = req.file.mimetype;
        try {
            analysisBuffer = await sharp(originalBuffer)
                .rotate()
                .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90 })
                .toBuffer();
            analysisMimeType = 'image/jpeg';
        } catch (imagePrepError) {
            console.warn('[PHOTO] Image normalization failed, using original upload:', imagePrepError.message);
        }

        const imageBase64 = analysisBuffer.toString('base64');
        console.log('[PHOTO] Analysis payload prepared:', {
            originalBytes: originalBuffer.length,
            analysisBytes: analysisBuffer.length,
            analysisMimeType,
            base64Length: imageBase64.length
        });

        const normalizeYesNo = (value) => ['true', 'yes', 'ready', 'mature', 'maturity', '1', 'detected', 'present'].includes(String(value ?? '').trim().toLowerCase());
        const cleanupUploadedPhoto = () => {
            if (req.file && fsModule.existsSync(req.file.path)) {
                fsModule.unlinkSync(req.file.path);
            }
        };
        const cropAliases = {
            onion: ['onion', 'shallot', 'allium cepa'],
            paddy: ['paddy', 'rice', 'oryza sativa'],
            tomato: ['tomato', 'solanum lycopersicum'],
            chilli: ['chilli', 'chili', 'chile', 'capsicum annuum'],
            banana: ['banana', 'plantain', 'musa'],
            maize: ['maize', 'corn', 'zea mays'],
            wheat: ['wheat', 'triticum'],
            potato: ['potato', 'solanum tuberosum'],
            sugarcane: ['sugarcane', 'saccharum officinarum'],
            cotton: ['cotton', 'gossypium'],
            groundnut: ['groundnut', 'peanut', 'arachis hypogaea'],
            soybean: ['soybean', 'soya', 'glycine max'],
            turmeric: ['turmeric', 'curcuma longa'],
            spinach: ['spinach', 'spinacia oleracea']
        };
        const cropCanonicalNames = {
            onion: 'Onion',
            paddy: 'Paddy',
            tomato: 'Tomato',
            chilli: 'Chilli',
            banana: 'Banana',
            maize: 'Maize',
            wheat: 'Wheat',
            potato: 'Potato',
            sugarcane: 'Sugarcane',
            cotton: 'Cotton',
            groundnut: 'Groundnut',
            soybean: 'Soybean',
            turmeric: 'Turmeric',
            spinach: 'Spinach'
        };
        const parsePhotoAnalysisJson = (raw) => {
            if (!raw) return null;
            if (typeof raw === 'object') return raw;
            if (typeof raw !== 'string') return null;
            const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
            const candidates = [cleaned];
            const match = cleaned.match(/\{[\s\S]*\}/);
            if (match && match[0] !== cleaned) candidates.push(match[0]);
            for (const candidate of candidates) {
                try { return JSON.parse(candidate); } catch (err) {}
            }
            return null;
        };
        const toConfidenceLabel = (score) => {
            if (score >= 80) return 'High';
            if (score >= 60) return 'Medium';
            return 'Low';
        };
        const parseConfidenceScore = (...values) => {
            for (const value of values) {
                if (value === null || value === undefined || value === '') continue;
                if (typeof value === 'number' && Number.isFinite(value)) return value <= 1 ? Math.round(value * 100) : Math.max(0, Math.min(100, Math.round(value)));
                const normalized = String(value).trim().toLowerCase();
                if (normalized === 'high') return 92;
                if (normalized === 'medium') return 68;
                if (normalized === 'low') return 35;
                const match = String(value).match(/(\d+(?:\.\d+)?)/);
                if (match) {
                    const numeric = parseFloat(match[1]);
                    if (!Number.isNaN(numeric)) return numeric <= 1 ? Math.round(numeric * 100) : Math.max(0, Math.min(100, Math.round(numeric)));
                }
            }
            return null;
        };
        const inferCropFromText = (...values) => {
            const text = values.filter(Boolean).map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ').toLowerCase();
            for (const [key, aliases] of Object.entries(cropAliases)) {
                if (aliases.some((alias) => text.includes(alias))) return cropCanonicalNames[key];
            }
            return null;
        };
        const buildConfidenceMeta = (score) => {
            if (score >= 80) return { recognitionStatus: 'recognized', confidenceMessage: 'Crop recognized with strong visual confidence.' };
            if (score >= 60) return { recognitionStatus: 'likely', confidenceMessage: 'Visual evidence is partial. Crop name will stay unknown unless features are clearly verifiable.' };
            return { recognitionStatus: 'unclear', confidenceMessage: 'The image is unclear. Please upload a closer, well-lit crop photo showing leaves, stem, fruit, or flower.' };
        };
        const splitList = (value, fallback = []) => {
            if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
            if (typeof value === 'string') return value.split(/\n|;|,/).map((item) => item.trim()).filter(Boolean);
            return fallback;
        };
        const toFrontendAnalysis = (data) => {
            const normalized = data && typeof data === 'object' ? data : {};
            const cropName = String(normalized.cropName || normalized.crop_name || '').trim();
            const confidence = String(normalized.confidence || '').trim() || 'Low';
            const fallbackCropName = inferCropFromText(
                normalized.reasoning,
                normalized.reason,
                normalized.notes,
                normalized.crop_description,
                normalized.disease_name
            ) || 'Crop detected';
            return {
                cropName: cropName || fallbackCropName,
                confidence,
                cropDescription: String(normalized.cropDescription || normalized.crop_description || '').trim(),
                healthStatus: String(normalized.healthStatus || normalized.health_status || 'Uncertain').trim() || 'Uncertain',
                diseaseDetected: normalizeYesNo(normalized.diseaseDetected ?? normalized.disease_detected) ? 'Yes' : 'No',
                diseaseName: normalized.diseaseName ?? normalized.disease_name ?? null,
                diseaseDescription: normalized.diseaseDescription ?? normalized.disease_description ?? normalized.diseaseDetails ?? normalized.disease_cause ?? null,
                severity: String(normalized.severity || normalized.disease_severity || 'None').trim() || 'None',
                harvestReady: normalizeYesNo(normalized.harvestReady ?? normalized.harvest_ready) ? 'Yes' : 'No',
                harvestNotes: String(normalized.harvestNotes || normalized.harvest_notes || normalized.harvest_timing || normalized.harvest_days_remaining || '').trim(),
                treatment: normalized.treatment && typeof normalized.treatment === 'object' ? normalized.treatment : { organic: [], chemical: [], preventive: [] },
                fertilizerRecommendations: Array.isArray(normalized.fertilizerRecommendations || normalized.fertilizer_recommendations)
                    ? (normalized.fertilizerRecommendations || normalized.fertilizer_recommendations)
                    : [],
                monthlyRecommendations: normalized.monthlyRecommendationsData || normalized.monthlyRecommendations || normalized.monthly_recommendations || {
                    current_month_tips: [],
                    next_month_tips: [],
                    watering_schedule: '',
                    sunlight_needs: ''
                },
                careTips: splitList(normalized.careTips || normalized.care_tips || normalized.care_tips_list, []),
                reasoning: String(normalized.reasoning || normalized.reason || normalized.notes || normalized.confidenceMessage || '').trim(),
                immediateAction: String(normalized.immediateAction || normalized.immediate_action || normalized.treatment?.immediate_actions || '').trim(),
                soilSuggestions: String(normalized.soilSuggestions || normalized.soil_suggestions || normalized.soil_health_tips || normalized.soil_health || '').trim()
            };
        };
        const validateCropPrediction = async (imageBuffer, normalizedData, rawText = '') => {
            if (!normalizedData || typeof normalizedData !== 'object') return normalizedData;

            const visualFeatures = await detectVisualCropFeatures(imageBuffer);
            const cropName = String(normalizedData.crop_name || normalizedData.cropName || '').trim();
            const cropNameLower = cropName.toLowerCase();
            const rawLower = String(rawText || '').toLowerCase();
            const confidenceScore = Number(normalizedData.confidenceScore || parseConfidenceScore(normalizedData.confidence) || 0);
            const grassNames = ['millet', 'paddy', 'rice', 'wheat', 'maize', 'corn', 'sugarcane'];
            const cottonSignals = ['boll', 'white fiber', 'white fibre', 'cotton flower', 'cotton boll', 'fluffy boll', 'white fluffy'];

            const hasCottonKeyword = cottonSignals.some((signal) => rawLower.includes(signal));
            const predictedGrassCrop = grassNames.includes(cropNameLower);
            const shouldForceCotton = hasCottonKeyword || (
                visualFeatures.hasCottonLikeBolls
                && visualFeatures.greenRatio > 0.2
                && visualFeatures.whiteRatio < 0.08
            );
            const looksUnclear = !cropName || cropNameLower === 'unclear crop image' || cropNameLower === 'unknown';

            if (shouldForceCotton && (predictedGrassCrop || looksUnclear)) {
                console.warn('[PHOTO] Validation override: cotton-like features detected, correcting crop prediction.', {
                    previousCrop: cropName || 'n/a',
                    visualFeatures,
                    hasCottonKeyword
                });
                normalizedData.crop_name = 'Cotton';
                normalizedData.cropName = 'Cotton';
                normalizedData.scientific_name = normalizedData.scientific_name && normalizedData.scientific_name !== 'Scientific identification unavailable'
                    ? normalizedData.scientific_name
                    : 'Gossypium hirsutum';
                normalizedData.scientificName = normalizedData.scientific_name;
                normalizedData.confidenceScore = Math.max(confidenceScore, 90);
                normalizedData.confidence = 'High';
                normalizedData.recognitionStatus = normalizedData.confidenceScore >= 80 ? 'recognized' : 'likely';
                normalizedData.identificationStatus = normalizedData.confidenceScore >= 80 ? 'Crop Identified' : 'Likely Crop';
                normalizedData.confidenceMessage = 'Validated from visible white cotton bolls and branching structure in the uploaded image.';
                normalizedData.notes = normalizedData.confidenceMessage;
                normalizedData.reason = normalizedData.confidenceMessage;
                normalizedData.cropIdentification = normalizedData.cropIdentification || {};
                normalizedData.cropIdentification.name = 'Cotton';
                normalizedData.cropIdentification.scientificName = normalizedData.scientific_name;
                normalizedData.cropIdentification.confidence = 'High';
                normalizedData.cropIdentification.bestMatch = normalizedData.recognitionStatus === 'recognized' ? 'recognized' : 'likely crop';
                normalizedData.top_predictions = [
                    { name: 'Cotton', confidence: 'High' }
                ];
            }

            if (!normalizedData.reason) {
                normalizedData.reason = shouldForceCotton
                    ? 'Based on visible white cotton bolls and plant branching pattern.'
                    : normalizedData.confidenceMessage;
            }

            const isCottonResult = String(normalizedData.crop_name || '').trim().toLowerCase() === 'cotton';
            const isMissingCrop = !cropName || cropNameLower === 'unknown crop' || cropNameLower === 'unclear crop image';
            const isLowConfidence = confidenceScore > 0 && confidenceScore < 60;
            if (!isCottonResult && (isMissingCrop || isLowConfidence)) {
                const fallbackCropName = inferCropFromText(
                    rawText,
                    normalizedData.scientific_name,
                    normalizedData.reasoning,
                    normalizedData.reason,
                    normalizedData.notes,
                    JSON.stringify(normalizedData.top_predictions || [])
                ) || String(normalizedData.crop_name || normalizedData.cropName || '').trim() || 'Crop detected';
                normalizedData.crop_name = fallbackCropName;
                normalizedData.cropName = fallbackCropName;
                normalizedData.identificationStatus = isMissingCrop ? 'Best Effort Identification' : 'Likely Crop';
                normalizedData.recognitionStatus = isLowConfidence ? 'likely' : 'recognized';
                normalizedData.confidence = 'Low';
                normalizedData.confidenceMessage = 'Best-effort crop identification returned from the visible features in the uploaded image.';
                normalizedData.notes = normalizedData.confidenceMessage;
                normalizedData.reason = normalizedData.reason || 'Visible crop features were limited, so this is a low-confidence best identification.';
                normalizedData.cropIdentification = normalizedData.cropIdentification || {};
                normalizedData.cropIdentification.name = fallbackCropName;
                normalizedData.cropIdentification.bestMatch = 'best effort';
                normalizedData.cropIdentification.confidence = 'Low';
                normalizedData.top_predictions = Array.isArray(normalizedData.top_predictions) && normalizedData.top_predictions.length
                    ? normalizedData.top_predictions
                    : [{ name: fallbackCropName, confidence: 'Low' }];
            }

            console.log('[PHOTO] Validation check:', {
                parsedCrop: cropName || 'n/a',
                correctedCrop: normalizedData.crop_name,
                confidenceScore: normalizedData.confidenceScore,
                visualFeatures
            });

            return normalizedData;
        };
        const sanitizePhotoAnalysis = (rawData, rawText = '', sourceLabel = 'AI Vision Analysis') => {
            const source = rawData && typeof rawData === 'object' ? rawData : {};
            const rawCropName = source.crop_name
                || source.cropName
                || source.cropIdentification?.name
                || source.cropIdentification?.crop
                || source.crop
                || source.cropType
                || inferCropFromText(source.scientific_name, source.notes, source.analysisSummary, rawText, source.cropIdentification);
            const cropName = String(rawCropName || '').trim();
            const confidenceScore = parseConfidenceScore(
                source.confidence,
                source.cropConfidence,
                source.topCrops?.[0]?.confidence,
                source.cropIdentification?.confidence,
                source.cropIdentification?.score,
                source.healthStatus?.confidence,
                source.diseaseDetection?.confidence
            ) ?? (cropName ? 68 : 35);
            const confidenceMeta = buildConfidenceMeta(confidenceScore);
            const diseaseDetected = normalizeYesNo(source.disease_detected ?? source.diseaseDetection?.detected ?? source.diseaseDetected);
            const harvestReady = normalizeYesNo(source.harvest_ready ?? source.growthStage?.harvestReady);
            const rawLower = [cropName, rawText, source.reasoning, source.reason, source.notes].filter(Boolean).join(' ').toLowerCase();
            const cottonEvidence = rawLower.includes('cotton boll')
                || rawLower.includes('white fluffy')
                || rawLower.includes('white cotton boll')
                || rawLower.includes('gossypium');
            const explicitLowConfidence = String(source.confidence || '').trim().toLowerCase() === 'low';
            const fallbackCropName = inferCropFromText(
                source.scientific_name,
                source.scientificName,
                source.reasoning,
                source.reason,
                source.notes,
                rawText,
                JSON.stringify(source.top_predictions || source.topCrops || [])
            ) || cropName || 'Crop detected';
            const verifiedCropName = cropName ? cropName : fallbackCropName;
            const confidenceLabel = String(source.confidence || '').trim() || toConfidenceLabel(confidenceScore);
            const monthlyRecommendations = Array.isArray(source.monthlyRecommendations)
                ? source.monthlyRecommendations.filter(Boolean).slice(0, 4)
                : Array.isArray(source.monthly_alternatives)
                    ? source.monthly_alternatives.filter(Boolean).slice(0, 4)
                    : [
                        'Maintain balanced irrigation and field sanitation this month.',
                        'Monitor leaves weekly for disease or pest symptoms.',
                        'Plan crop rotation based on local season and soil moisture.'
                    ];
            const careTipsList = splitList(source.careTips || source.care_tips_list || source.care_tips, [
                source.care_tips?.watering || source.careTips?.watering || '',
                source.care_tips?.soil || source.careTips?.soil || '',
                source.care_tips?.sunlight || source.careTips?.sunlight || ''
            ]).slice(0, 4);
            const fertilizerRecommendations = Array.isArray(source.fertilizer_recommendations)
                ? source.fertilizer_recommendations.filter(Boolean).slice(0, 4)
                : Array.isArray(source.fertilizerRecommendations)
                    ? source.fertilizerRecommendations.filter(Boolean).slice(0, 4)
                    : [];
            const treatmentAdviceList = splitList(source.treatmentAdviceList || source.treatment_advice || source.treatmentAdvice, [
                source.treatment?.organic || source.treatmentAdvice?.organic || 'Maintain field hygiene, balanced irrigation, and regular scouting.',
                source.treatment?.chemical || source.treatmentAdvice?.chemical || 'Use crop-specific treatment only after confirming symptoms in the field.',
                source.treatment?.prevention || source.treatmentAdvice?.prevention || 'Inspect leaves weekly, avoid waterlogging, and remove infected plant parts early.'
            ]).slice(0, 4);
            const fertilizerSuggestion = splitList(source.fertilizerSuggestion || source.fertilizer_plan || source.fertilizerPlan, [
                'Apply balanced NPK based on soil test results.',
                'Use compost or farmyard manure to improve soil structure.',
                'Add micronutrients only if visible deficiency symptoms persist.'
            ]).slice(0, 4);
            const immediateAction = source.immediateAction
                || source.immediate_action
                || source.treatment?.immediate_actions
                || source.treatmentAdvice?.immediateActions
                || 'Continue monitoring and capture a closer image if disease-level confirmation is needed.';
            const monthlyRecommendationsData = source.monthly_recommendations && typeof source.monthly_recommendations === 'object'
                ? source.monthly_recommendations
                : source.monthlyRecommendations && typeof source.monthlyRecommendations === 'object' && !Array.isArray(source.monthlyRecommendations)
                    ? source.monthlyRecommendations
                    : null;
            const diseaseDetails = diseaseDetected
                ? (source.disease_description || source.disease_cause || source.diseaseDetection?.symptoms || source.disease_name || 'Visible stress markers detected in the image.')
                : 'No visible disease symptoms detected in this image.';
            const pestDetected = normalizeYesNo(source.pestDetected ?? source.pestDetection?.detected);
            const pestDetails = pestDetected
                ? (source.pestDetails || source.pestDetection?.details || 'Possible pest activity observed in the image.')
                : 'No visible pest symptoms detected in this image.';
            const topPredictions = Array.isArray(source.topCrops)
                ? source.topCrops
                    .map((item) => {
                        if (!item) return null;
                        if (typeof item === 'string') return { name: item, confidence: 'Unknown' };
                        const name = item.name || item.cropName || item.crop || item.label;
                        if (!name) return null;
                        const topConfidence = parseConfidenceScore(item.confidence, item.score);
                        return {
                            name: String(name).trim(),
                            confidence: topConfidence != null ? `${topConfidence}%` : String(item.confidence || item.score || 'Unknown')
                        };
                    })
                    .filter(Boolean)
                    .slice(0, 2)
                : Array.isArray(source.top_predictions)
                    ? source.top_predictions.slice(0, 2)
                    : [];
            const scientificName = source.scientific_name
                || source.scientificName
                || source.cropIdentification?.scientificName
                || source.cropIdentification?.scientific_name
                || 'Scientific identification unavailable';
            const identificationStatus = typeof source.identificationStatus === 'string' && source.identificationStatus.trim() && verifiedCropName !== 'Crop detected'
                ? source.identificationStatus.trim()
                : verifiedCropName !== 'Crop detected'
                    ? 'Crop Identified'
                    : 'Best Effort Identification';
            const reason = verifiedCropName !== 'Crop detected'
                ? (source.reasoning || source.reason || source.notes || source.analysisSummary || confidenceMeta.confidenceMessage)
                : 'Visible crop features were limited, so the result is a best-effort crop match.';
            return {
                crop_name: verifiedCropName,
                scientific_name: scientificName,
                confidence: explicitLowConfidence ? 'Low' : confidenceLabel,
                confidenceScore,
                recognitionStatus: explicitLowConfidence ? 'likely' : confidenceMeta.recognitionStatus,
                confidenceMessage: confidenceMeta.confidenceMessage,
                identificationStatus,
                cropName: verifiedCropName,
                crop_description: source.crop_description || source.cropDescription || '',
                cropDescription: source.crop_description || source.cropDescription || '',
                healthStatus: source.health_status || source.healthStatus?.overall || source.healthStatus?.status || (diseaseDetected ? 'Needs attention' : 'Healthy'),
                diseaseDetected: diseaseDetected ? 'Yes' : 'No',
                disease_description: source.disease_description || diseaseDetails,
                diseaseDescription: source.disease_description || diseaseDetails,
                harvestReady: harvestReady ? 'Yes' : 'No',
                harvest_notes: source.harvest_notes || source.harvestNotes || source.harvest_timing || '',
                harvestNotes: source.harvest_notes || source.harvestNotes || source.harvest_timing || '',
                careTips: careTipsList,
                reasoning: reason,
                immediate_action: source.immediate_action || immediateAction,
                immediateAction: source.immediate_action || immediateAction,
                soil_suggestions: source.soil_suggestions || source.soilSuggestions || source.soil_health_tips || '',
                soilSuggestions: source.soil_suggestions || source.soilSuggestions || source.soil_health_tips || '',
                cropIdentification: {
                    name: verifiedCropName,
                    scientificName,
                    confidence: explicitLowConfidence ? 'Low' : confidenceLabel,
                    bestMatch: explicitLowConfidence ? 'best effort' : (confidenceMeta.recognitionStatus === 'recognized' ? 'recognized' : 'likely crop')
                },
                healthStatusDetails: {
                    overall: source.health_status || source.healthStatus?.overall || source.healthStatus?.status || (diseaseDetected ? 'Needs attention' : 'Healthy'),
                    summary: source.healthStatus?.summary || source.notes || (diseaseDetected ? 'Visual stress markers detected.' : 'No major disease symptoms were clearly visible.'),
                    confidence: `${parseConfidenceScore(source.healthStatus?.confidence, confidenceScore) || confidenceScore}%`
                },
                diseaseDetectionDetails: {
                    detected: diseaseDetected,
                    diseaseName: source.disease_name || source.diseaseDetection?.diseaseName || source.diseaseDetection?.name || (diseaseDetected ? 'Possible disease or stress detected' : null),
                    severity: source.severity || source.disease_severity || source.diseaseDetection?.severity || (diseaseDetected ? 'Moderate' : 'Healthy'),
                    symptoms: diseaseDetails,
                    confidence: `${parseConfidenceScore(source.diseaseDetection?.confidence, confidenceScore) || confidenceScore}%`
                },
                treatmentAdviceDetails: {
                    organic: source.treatment?.organic || source.treatmentAdvice?.organic || 'Maintain field hygiene, balanced irrigation, and regular scouting.',
                    chemical: source.treatment?.chemical || source.treatmentAdvice?.chemical || 'Use crop-specific treatment only after confirming symptoms in the field.',
                    prevention: source.treatment?.prevention || source.treatmentAdvice?.prevention || 'Inspect leaves weekly, avoid waterlogging, and remove infected plant parts early.',
                    immediateActions: source.treatment?.immediate_actions || source.treatmentAdvice?.immediateActions || 'Take a closer leaf image if you need disease-level confirmation.'
                },
                growthStageDetails: {
                    stage: source.growth_stage || source.growthStage?.stage || 'Vegetative',
                    summary: source.growthStage?.summary || source.harvest_timing || 'Continue routine crop care and monitor maturity signs.',
                    harvestReady
                },
                growth_stage: source.growth_stage || source.growthStage?.stage || 'Vegetative',
                harvest_ready: harvestReady ? 'Yes' : 'No',
                harvest_timing: source.harvest_timing || (source.harvest_days_remaining != null ? `${source.harvest_days_remaining} days remaining` : '') || source.growthStage?.summary || 'Monitor the crop over the coming days before harvest.',
                harvest_guidance: source.harvest_guidance || (harvestReady ? 'Harvest during the cooler part of the day using clean tools.' : 'Wait for clearer maturity signs such as color, size, and firmness before harvest.'),
                disease_detected: diseaseDetected ? 'Yes' : 'No',
                disease_name: source.disease_name || source.diseaseDetection?.diseaseName || source.diseaseDetection?.name || (diseaseDetected ? 'Possible disease or stress detected' : null),
                severity: source.severity || source.disease_severity || source.diseaseDetection?.severity || (diseaseDetected ? 'Moderate' : 'Healthy'),
                disease_severity: source.disease_severity || source.severity || source.diseaseDetection?.severity || (diseaseDetected ? 'Moderate' : null),
                disease_cause: diseaseDetails,
                treatment: {
                    organic: splitList(source.treatment?.organic || source.treatmentAdvice?.organic, []),
                    chemical: splitList(source.treatment?.chemical || source.treatmentAdvice?.chemical, []),
                    preventive: splitList(source.treatment?.preventive || source.treatment?.prevention || source.treatmentAdvice?.prevention, []),
                    prevention: splitList(source.treatment?.preventive || source.treatment?.prevention || source.treatmentAdvice?.prevention, []),
                    immediate_actions: source.treatment?.immediate_actions || source.treatmentAdvice?.immediateActions || 'Take a closer leaf image if you need disease-level confirmation.'
                },
                care_tips: {
                    watering: source.care_tips?.watering || source.careTips?.watering || '',
                    soil: source.care_tips?.soil || source.careTips?.soil || '',
                    sunlight: source.care_tips?.sunlight || source.careTips?.sunlight || '',
                    maintenance: source.care_tips?.maintenance || source.careTips?.maintenance || ''
                },
                notes: reason,
                reasoning: reason,
                reason,
                top_predictions: topPredictions,
                monthlyRecommendations,
                monthly_recommendations: monthlyRecommendationsData || {
                    current_month_tips: monthlyRecommendations.slice(0, 3),
                    next_month_tips: [],
                    watering_schedule: '',
                    sunlight_needs: ''
                },
                monthly_alternatives: monthlyRecommendations,
                expected_yield: source.expected_yield || source.expectedYield || 'Yield estimate unavailable from image-only analysis.',
                soil_health_tips: source.soil_health_tips || source.soilHealthTips || source.soil_health || 'Use compost, maintain drainage, and test soil if growth appears uneven.',
                soil_health: source.soil_health || source.soilHealth || 'Average',
                fertilizer_recommendations: fertilizerRecommendations,
                fertilizer_recommendation: source.fertilizer_recommendation || fertilizerSuggestion[0] || '',
                watering_advice: source.watering_advice || monthlyRecommendationsData?.watering_schedule || '',
                pest_risk: source.pest_risk || (pestDetected ? 'Medium' : 'Low'),
                harvest_days_remaining: source.harvest_days_remaining ?? null,
                monthly_recommendation: source.monthly_recommendation || monthlyRecommendations[0] || '',
                rawModelSource: sourceLabel,
                scientificName,
                diseaseDetails,
                pestDetected: pestDetected ? 'Yes' : 'No',
                pestDetails,
                growthStageName: source.growth_stage || source.growthStage?.stage || 'Vegetative',
                treatmentAdviceList,
                fertilizerSuggestion,
                immediateAction,
                monthlyCropRecommendations: monthlyRecommendations,
                fertilizerRecommendations,
                monthlyRecommendationsData: monthlyRecommendationsData || {
                    current_month_tips: monthlyRecommendations.slice(0, 3),
                    next_month_tips: [],
                    watering_schedule: '',
                    sunlight_needs: ''
                }
            };
        };
        const buildFallbackPhotoData = (identifiedCrop, sourceLabel = 'Fallback plant identification') => sanitizePhotoAnalysis({
            crop_name: identifiedCrop?.crop_name || 'Detected crop',
            scientific_name: identifiedCrop?.scientific_name || 'Scientific identification unavailable',
            confidence: identifiedCrop?.confidence || '70%',
            growth_stage: 'Vegetative',
            harvest_ready: 'No',
            harvest_timing: 'Monitor maturity signs before harvest.',
            harvest_guidance: 'Inspect the crop over the next few days and confirm maturity before harvesting.',
            disease_detected: 'No',
            disease_name: 'No visible disease detected',
            severity: 'Healthy',
            disease_cause: 'No major visual disease markers were confidently confirmed from this image.',
            treatment: {
                organic: 'Maintain balanced irrigation, field sanitation, and routine scouting.',
                chemical: 'Use crop-specific treatment only if symptoms appear or spread.',
                prevention: 'Inspect leaves weekly, avoid waterlogging, and keep weeds under control.',
                immediate_actions: 'API fallback response: continue monitoring and upload a clearer crop image if you need disease-level analysis.'
            },
            notes: `${sourceLabel} identified the crop, but detailed disease analysis could not be confirmed from this image.`,
            monthlyRecommendations: []
        }, '', sourceLabel);
        const sendSuccessfulAnalysis = async (photoData, sourceLabel = 'AI Vision Analysis') => {
            const normalizedPhotoData = sanitizePhotoAnalysis(photoData, JSON.stringify(photoData || {}), sourceLabel);
            const validatedPhotoData = await validateCropPrediction(analysisBuffer, normalizedPhotoData, JSON.stringify(photoData || {}));
            const harvestReady = normalizeYesNo(validatedPhotoData.harvest_ready);
            const diseaseDetected = normalizeYesNo(validatedPhotoData.disease_detected);
            const frontendAnalysis = toFrontendAnalysis(validatedPhotoData);
            console.log('[PHOTO] Normalized backend response:', frontendAnalysis);
            console.log('[PHOTO] Final object sent to frontend:', validatedPhotoData);
            const response = res.json({
                success: true,
                status: 'success',
                analysis: frontendAnalysis,
                disease: diseaseDetected ? validatedPhotoData.disease_name : 'none',
                confidence: validatedPhotoData.confidence,
                recognitionStatus: validatedPhotoData.recognitionStatus,
                recommendation: validatedPhotoData.treatment?.immediate_actions || (diseaseDetected ? 'Follow the treatment guidance in the analysis.' : 'Standard care and monitoring are sufficient.'),
                harvestReady,
                harvestGuidance: validatedPhotoData.harvest_guidance,
                photoData: validatedPhotoData,
                debug: { source: validatedPhotoData.rawModelSource }
            });
            cleanupUploadedPhoto();
            return response;
        };

        const prompt = `You are an expert agricultural AI system.

STRICT INSTRUCTION:
- NEVER return "unclear image" or fallback unless the image is completely blank or unreadable.
- ALWAYS attempt full crop analysis even if confidence is low.
- If unsure, make the BEST POSSIBLE prediction instead of failing.

Your task:
Analyze the uploaded crop image completely and return structured output.

RESPONSE FORMAT (STRICT JSON):

{
  "crop_name": "",
  "confidence": "",
  "health_status": "",
  "disease_detected": "",
  "disease_name": "",
  "disease_severity": "",
  "symptoms": [],
  "treatment": [],
  "fertilizer_recommendation": [],
  "growth_stage": "",
  "harvest_ready": "",
  "care_tips": [],
  "monthly_recommendations": []
}

RULES:
- crop_name must always be identified (NO empty)
- confidence must be High / Medium / Low
- If no disease -> set disease_detected = "No" and still give care tips
- If disease present -> give exact medicine, pesticide, or organic treatment
- fertilizer_recommendation must include NPK values if possible
- growth_stage must be one of: Seedling / Vegetative / Flowering / Fruiting / Harvest
- monthly_recommendations: suggest 3-5 alternative crops based on Indian conditions

IMPORTANT:
- DO NOT say "cannot determine"
- DO NOT return fallback messages
- DO NOT leave fields empty
- Always produce meaningful agricultural insights

Image is a crop plant. Analyze deeply.`;

        const analysisAttempts = [
            {
                label: 'Gemini Vision',
                run: async () => {
                    if (!geminiAI) return null;
                    try {
                        const response = await geminiAI.models.generateContent({
                            model: 'gemini-2.0-flash',
                            contents: [{
                                parts: [
                                    { text: prompt },
                                    { inlineData: { mimeType: analysisMimeType, data: imageBase64 } }
                                ]
                            }],
                            config: {
                                responseMimeType: 'application/json',
                                temperature: 0.2,
                                topP: 0.9,
                                maxOutputTokens: 4096
                            }
                        });
                        return response.text || null;
                    } catch (geminiError) {
                        console.error('[PHOTO] Gemini vision failed:', geminiError.message);
                        return null;
                    }
                }
            },
            {
                label: 'OpenAI Vision',
                run: () => getOpenAIVisionResponse(prompt, { mimeType: analysisMimeType, base64: imageBase64 }, null)
            },
            {
                label: 'OpenRouter Vision',
                run: () => getAIResponse(prompt, [], false, { mimeType: analysisMimeType, base64: imageBase64 })
            }
        ];

        let finalData = null;
        let finalSourceLabel = '';
        for (const attempt of analysisAttempts) {
            const rawResponse = await attempt.run();
            if (!rawResponse) continue;
            console.log(`[PHOTO] Raw ${attempt.label} response:`, typeof rawResponse === 'string' ? rawResponse.slice(0, 1200) : rawResponse);
            const parsedResponse = parsePhotoAnalysisJson(rawResponse);
            if (parsedResponse) {
                console.log(`[PHOTO] Parsed ${attempt.label} JSON:`, parsedResponse);
                finalData = parsedResponse;
                finalSourceLabel = attempt.label;
                break;
            }
            console.warn(`[PHOTO] ${attempt.label} response could not be parsed as JSON.`);
        }

        if (finalData?.error && /invalid detection/i.test(String(finalData.error))) {
            cleanupUploadedPhoto();
            return res.status(400).json({
                status: 'failed',
                message: finalData.message || 'Agricultural domain restricted. Please upload crop photo.',
                debug: { source: finalSourceLabel || 'AI Vision' }
            });
        }

        const normalizedAiData = finalData ? sanitizePhotoAnalysis(finalData, JSON.stringify(finalData), finalSourceLabel || 'AI Vision Analysis') : null;
        if (normalizedAiData && (normalizedAiData.crop_name || normalizedAiData.notes || normalizedAiData.recognitionStatus === 'unclear')) {
            if (normalizedAiData.recognitionStatus === 'unclear' || normalizedAiData.confidenceScore < 80) {
                try {
                    const localVisualMatch = await classifyCropWithLocalReferences(analysisBuffer);
                    const hasValidAiCrop = normalizedAiData.crop_name && normalizedAiData.crop_name !== 'Crop detected';
                    if (!hasValidAiCrop && localVisualMatch && (localVisualMatch.confidence >= 88 || String(localVisualMatch.crop_name || '').trim().toLowerCase() === 'cotton')) {
                        console.log('[PHOTO] Local visual classifier match:', localVisualMatch);
                        if (!normalizedAiData.crop_name || normalizedAiData.recognitionStatus === 'unclear' || localVisualMatch.confidence > normalizedAiData.confidenceScore) {
                            normalizedAiData.crop_name = localVisualMatch.crop_name;
                            normalizedAiData.cropName = localVisualMatch.crop_name;
                            normalizedAiData.confidence = toConfidenceLabel(localVisualMatch.confidence);
                            normalizedAiData.confidenceScore = localVisualMatch.confidence;
                            normalizedAiData.cropIdentification.name = localVisualMatch.crop_name;
                            normalizedAiData.cropIdentification.confidence = toConfidenceLabel(localVisualMatch.confidence);
                            normalizedAiData.cropIdentification.bestMatch = localVisualMatch.confidence >= 80 ? 'recognized' : 'likely crop';
                            normalizedAiData.identificationStatus = 'Crop Identified';
                            normalizedAiData.recognitionStatus = 'recognized';
                            normalizedAiData.confidenceMessage = localVisualMatch.confidence >= 80
                                ? 'Local visual verification strongly matched the uploaded crop image.'
                                : 'Local visual verification suggests this is the most likely crop match.';
                            normalizedAiData.notes = normalizedAiData.notes || normalizedAiData.confidenceMessage;
                            normalizedAiData.top_predictions = localVisualMatch.topMatches;
                            normalizedAiData.rawModelSource = `${normalizedAiData.rawModelSource} + Local Reference Matching`;
                        }
                    }
                } catch (localMatchError) {
                    console.warn('[PHOTO] Local visual classifier failed:', localMatchError.message);
                }
            }
            return sendSuccessfulAnalysis(normalizedAiData, finalSourceLabel || 'AI Vision Analysis');
        }

        const identifiedCrop = await callExternalCropAPI(req.file.path, 'plantnet')
            || await callExternalCropAPI(req.file.path, 'perenual');

        if (identifiedCrop && identifiedCrop.crop_name) {
            console.log('[PHOTO] External crop API identified crop:', identifiedCrop);
            return sendSuccessfulAnalysis(buildFallbackPhotoData(identifiedCrop, identifiedCrop.source), identifiedCrop.source || 'External crop API fallback');
        }

        try {
            const localVisualMatch = await classifyCropWithLocalReferences(analysisBuffer);
            if (localVisualMatch && localVisualMatch.confidence >= 85) {
                console.log('[PHOTO] Using local visual classifier fallback:', localVisualMatch);
                return sendSuccessfulAnalysis(buildFallbackPhotoData({
                    crop_name: localVisualMatch.crop_name,
                    scientific_name: 'Local visual classifier',
                    confidence: `${localVisualMatch.confidence}%`
                }, 'Local visual reference matching'), 'Local visual reference matching');
            }
        } catch (localMatchError) {
            console.warn('[PHOTO] Local visual fallback failed:', localMatchError.message);
        }

        const gracefulFallback = buildFallbackPhotoData({
            crop_name: inferCropFromText(req.file.originalname) || 'Unclear crop image',
            scientific_name: 'Identification uncertain',
            confidence: '35%'
        }, 'Graceful fallback response');
        gracefulFallback.notes = 'The system could not confidently identify the crop from this image. Please upload a clearer close-up photo showing leaves, stem, fruit, or flower.';
        gracefulFallback.confidenceMessage = 'The image is unclear. Please upload a clearer close-up plant photo.';
        gracefulFallback.recognitionStatus = 'unclear';
        gracefulFallback.cropIdentification.bestMatch = 'unclear';
        gracefulFallback.cropIdentification.confidence = '35%';
        gracefulFallback.monthlyRecommendations = [
            'Retake the photo in daylight and keep the crop in clear focus.',
            'Capture leaves or fruits closer to the camera for better identification.',
            'Avoid blurry, distant, or heavily shaded field images.'
        ];
        gracefulFallback.monthly_alternatives = gracefulFallback.monthlyRecommendations;
        return sendSuccessfulAnalysis(gracefulFallback, 'Graceful fallback response');
    } catch (e) {
        console.error('[PHOTO] Server analysis failed:', e.message);
        if (req.file && fsModule.existsSync(req.file.path)) fsModule.unlinkSync(req.file.path);
        return res.status(500).json({ status: 'failed', message: 'Unable to analyze the uploaded crop image right now.', debug: { error: e.message } });
    }
});


app.post('/api/chat', requireAuth, async (req, res) => {
    try {
        const { message, history = [] } = req.body || {};
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Message is required.' });
        }

        const userMessage = message.trim().toLowerCase();

        // Using OpenRouter with provided key (Always Configured)
        const isConfigured = true;

        // Build system prompt for agricultural context
        const systemPrompt = `You are CropAI Assistant, an expert agricultural advisor specializing in Indian farming.
You help farmers with:
- Crop selection and recommendations based on soil, climate, and season
- Disease identification and prevention
- Irrigation and water management
- Fertilizer and nutrient management

- Pest control strategies

- Harvest timing and post-harvest handling

- Market prices and profitability analysis

- Sustainable farming practices



Always provide practical, actionable advice. Use simple language suitable for farmers.

When relevant, mention specific crop varieties, quantities, and timings.

If asked about topics unrelated to agriculture, politely redirect to farming topics.

Keep responses concise but informative (2-4 paragraphs max).`;



        const geminiHistory = history.slice(-10).map(h => ({

            role: h.role === 'assistant' ? 'assistant' : 'user',

            content: h.content

        }));



        const reply = await getAIResponse(message.trim(), geminiHistory, true, null, systemPrompt);

        

        if (!reply) {

            console.error('[CHAT_ERROR] OpenRouter failed all models. Check API Key: ' + apiKey.substring(0, 10) + '...');

            throw new Error('AI_OFFLINE');

        }



        return res.json({ reply, configured: true });

    } catch (error) {

        console.error('Final Chat API error:', error.message);



        // Enhanced fallback: provide the user with the actual reason if possible

        const fallbackReply = getFallbackResponse(req.body.message || '');

        return res.json({

            reply: fallbackReply + "\n\n(Note: Connection to Al model failed. Please verify your OpenRouter API key and internet connectivity.)",

            configured: true,

            isFallback: true
        });
    }
});




// Helper function for local fallback responses
function getFallbackResponse(query) {
    query = query.toLowerCase();

    if (query.includes('hello') || query.includes('hi ') || query.includes('greeting')) {
        return "Namaste! I am your CropAI Assistant. I can help you with crop recommendations, disease management, and farming advice. What would you like to know today?";
    }

    if (query.includes('tomato')) {
        return "Tomatoes require well-drained loamy soil with pH 6.0-7.0. Best planting time is Oct-Nov or Feb-Mar. Common diseases include Early Blight and Leaf Curl. Use resistant varieties and ensure proper spacing.";
    }

    if (query.includes('rice') || query.includes('paddy')) {
        return "Rice needs clay or clay-loam soil with good water retention. Maintain 2-5 cm water level during vegetative stage. Apply Nitrogen in splits for better yield. Watch out for Blast disease and Stem borer.";
    }

    if (query.includes('wheat')) {
        return "Wheat thrives in cool winters. Sowing is best in Nov-Dec. Requires 4-6 irrigations at critical stages like CRI (21 days). managing weeds like Phalaris minor is crucial for good yield.";
    }

    if (query.includes('cotton')) {
        return "Cotton grows well in black soil (Regur). Sowing is done in Apr-May (irrigated) or June-July (rainfed). Protect from Bollworms using IPM strategies. Avoid waterlogging at all stages.";
    }

    if (query.includes('fertilizer') || query.includes('nutrient')) {
        return "Balanced fertilization is key. Always use fertilizers based on Soil Health Card recommendations. Generally, NPK ratio of 4:2:1 is suggested for cereals, but it varies by crop and soil status.";
    }

    if (query.includes('pest') || query.includes('insect')) {
        return "Integrated Pest Management (IPM) is best. 1. Use light traps. 2. Encourage natural enemies like ladybugs. 3. Use Neem oil spray (5%) as preventive. 4. Apply chemical pesticides only at ETL (Economic Threshold Level).";
    }

    if (query.includes('water') || query.includes('irrigation')) {
        return "Water is precious! Drip irrigation saves 40-60% water and increases yield. For paddy, use alternate wetting and drying (AWD). Avoid over-irrigation to prevent root rot and soil salinity.";
    }

    if (query.includes('soil')) {
        return "Healthy soil means healthy crops. Add organic matter like FYM or vermicompost every season. Practice crop rotation with legumes to fix nitrogen. Test your soil pH and nutrients every 2-3 years.";
    }

    return "I am currently in offline mode and can answer basic questions about major crops like Rice, Wheat, Tomato, Cotton, etc. Please specificy a crop name or topic like 'fertilizer' or 'irrigation'. For full AI capabilities, please configure the API key.";
}





// --- ADDITIONAL DASHBOARD ROUTES ---

app.get('/api/climate-data', async (req, res) => {
    try {
        const { lat, lng } = req.query;
        
        // Use Open-Meteo for free, highly accurate real-time and 5-day forecast data
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${Number(lat).toFixed(2)}&longitude=${Number(lng).toFixed(2)}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
        
        const response = await axios.get(url);
        const data = response.data;

        if (data.error) {
            throw new Error('Open-Meteo API Error');
        }

        const current = data.current;
        const daily = data.daily;
        
        const forecast = [];
        for (let i = 0; i < 5; i++) {
            forecast.push({
                date: daily.time[i],
                maxTemp: daily.temperature_2m_max[i].toFixed(1),
                minTemp: daily.temperature_2m_min[i].toFixed(1),
                rain: daily.precipitation_sum[i].toFixed(1),
                code: daily.weather_code[i]
            });
        }

        res.json({
            temperature: Number(current.temperature_2m.toFixed(1)),
            temp: `${current.temperature_2m.toFixed(1)}°C`,
            humidity: current.relative_humidity_2m,
            rain: `${current.precipitation.toFixed(1)}mm`,
            precipitation: Number(current.precipitation.toFixed(1)),
            status: 'Optimal',
            city: 'Location',
            region: 'Selected Region',
            forecast: forecast
        });

    } catch (e) {
        console.error('Weather error:', e);
        const mockTemp = 28 + Math.random() * 4;
        const mockRain = Math.random() > 0.8 ? Math.random() * 12 : 0;
        res.json({
            temperature: Number(mockTemp.toFixed(1)),
            temp: `${mockTemp.toFixed(1)}°C`,
            humidity: Number((65 + Math.random() * 10).toFixed(1)),
            rain: `${mockRain.toFixed(1)}mm`,
            precipitation: Number(mockRain.toFixed(1)),
            status: 'Offline',
            city: 'Location',
            region: 'Selected Region',
            forecast: []
        });
    }
/*
        const { lat, lng } = req.query;
        const apiKey = process.env.WEATHERSTACK_API_KEY;
        if (!apiKey || apiKey.includes('your-') || apiKey === '') {
            const mockTemp = 28 + Math.random() * 5;
            return res.json({
                temp: `${mockTemp.toFixed(1)}°C`,
                humidity: (65 + Math.random() * 15).toFixed(1),
                rain: `${(Math.random() * 10).toFixed(1)}mm`,
                status: 'Optimal',
                forecast: generateForecast(mockTemp)
            });
        }

        const response = await fetch(`http://api.weatherstack.com/current?access_key=${apiKey}&query=${lat},${lng}`);
        const result = await response.json();

        if (result.error) {
            console.error('Weatherstack Error:', result.error);
            const mockTemp = 28 + Math.random() * 5;
            return res.json({
                temp: `${mockTemp.toFixed(1)}°C`,
                humidity: (65 + Math.random() * 15).toFixed(1),
                rain: `${(Math.random() * 10).toFixed(1)}mm`,
                status: 'Optimal',
                forecast: generateForecast(mockTemp)
            });
        }

        res.json({
            temp: `${result.current.temperature}°C`,
            humidity: result.current.humidity,
            rain: `${result.current.precip}mm`,
            status: result.current.weather_descriptions?.[0] || 'Optimal',
            city: result.location.name,
            region: result.location.region,
            forecast: generateForecast(result.current.temperature)
        });
    } catch (e) {
        console.error('Weather error:', e);
        res.json({ temp: 'N/A', status: 'Offline' });
    }
*/
});

app.get('/api/sensors', (req, res) => {
    // Simulated IoT sensor readings
    res.json({
        temperature: (25 + Math.random() * 10).toFixed(1),
        humidity: (60 + Math.random() * 20).toFixed(1),
        soilMoisture: (30 + Math.random() * 40).toFixed(1),
        pH: (6.0 + Math.random() * 1.5).toFixed(1),
        rainfall: (50 + Math.random() * 100).toFixed(1)
    });
});

app.get('/api/repair-image', async (req, res) => {
    try {
        const { crop } = req.query;
        if (!crop) return res.status(400).json({ error: 'Crop name is required' });

        console.log(`[AI] Generating high-accuracy repair prompt for: ${crop}`);

        const prompt = `
        You are an agricultural photography expert and botanical illustrator. 
        Generate an ultra-accurate, technical visual description for the crop species: "${crop}".
        
        The description must follow these STRICT botanical rules:
        - Identify the specific plant parts: leaves (pinnate, broad, etc.), stems, pods, or grain heads.
        - Specify the growth stage: "growing in a lush tropical field" or "ready for harvest".
        - COLOR PALETTE: Focus on earthy greens, browns, and sunlight.
        - CRITICAL NEGATIVE CONSTRAINTS: ABSOLUTELY NO ANIMALS, NO CATS, NO DOGS, NO STATUES, NO HUMANS, NO BUILDINGS, NO FOOD ON PLATES.
        - ONLY SHOW THE PLANT IN THE FIELD.
        
        Format: Return ONLY the optimized search prompt.
        `;

        const repairPrompt = await getAIResponse(prompt, [], false);
        
        if (!repairPrompt) {
            return res.json({ 
                prompt: `${crop} plant growing in agricultural field, professional botanical photography, 8k, detailed, no animals, no humans`
            });
        }

        res.json({ prompt: repairPrompt.trim() });
    } catch (e) {
        res.status(500).json({ error: 'Failed to generate repair prompt' });
    }
});

async function handleCropRecommendationLogic(req, res) {
    try {
        console.log('[RECOMMEND] req.body:', JSON.stringify(req.body, null, 2));
        const normalizedInput = normalizeDynamicRecommendationInput(req.body || {});
        console.log('[RECOMMEND] normalizedInput:', JSON.stringify(normalizedInput, null, 2));
        const {
            soilType,
            climate,
            season,
            waterAvailability,
            farmSize,
            temperature,
            humidity,
            ph,
            rainfall,
            soilMoisture
        } = normalizedInput;
        const currentConditions = req.body?.currentConditions || {};
        const n = parseDynamicRecommendationNumber(req.body?.n, req.body?.N);
        const p = parseDynamicRecommendationNumber(req.body?.p, req.body?.P);
        const k = parseDynamicRecommendationNumber(req.body?.k, req.body?.K);

        const missingFarmFields = [];
        if (!String(normalizedInput.soilType || '').trim()) missingFarmFields.push('soilType');
        if (!String(normalizedInput.climate || '').trim()) missingFarmFields.push('climate');
        if (!String(normalizedInput.season || '').trim()) missingFarmFields.push('season');
        if (!String(normalizedInput.waterAvailability || '').trim()) missingFarmFields.push('waterAvailability');
        if (!Number.isFinite(normalizedInput.farmSize) || normalizedInput.farmSize <= 0) missingFarmFields.push('farmSize');

        const conditionFieldMap = [
            ['temperature', normalizedInput.temperature],
            ['humidity', normalizedInput.humidity],
            ['soilMoisture', normalizedInput.soilMoisture],
            ['pH', normalizedInput.ph],
            ['rainfall', normalizedInput.rainfall]
        ];
        const missingCondFields = conditionFieldMap.filter(([, v]) => !Number.isFinite(v)).map(([k]) => k);
        const allMissing = [...missingFarmFields, ...missingCondFields];

        if (allMissing.length > 0) {
            console.log('[RECOMMEND] Missing fields:', allMissing);
            return res.status(400).json({
                success: false,
                message: `Missing required field${allMissing.length > 1 ? 's' : ''}: ${allMissing.join(', ')}`,
                error: `Missing required field${allMissing.length > 1 ? 's' : ''}: ${allMissing.join(', ')}`,
                recommendations: [],
                crops: []
            });
        }
        
        console.log(`[INFO] Generating crop recommendations for: ${normalizedInput.soilType}, ${normalizedInput.climate}, ${normalizedInput.season}, ${normalizedInput.temperature}C, ${normalizedInput.rainfall}mm`);

        console.log(`[INFO] Generating crop recommendations for: ${soilType}, ${temperature}°C, ${rainfall}mm`);

        let datasetRecommendations = buildDynamicDatasetRecommendations(req.body || {});
        if (!datasetRecommendations || !Array.isArray(datasetRecommendations.recommendations) || datasetRecommendations.recommendations.length === 0) {
            datasetRecommendations = {
                ...buildCatalogRuleRecommendations(req.body || {}, MIN_RECOMMENDATION_RESULTS),
                message: 'No suitable crops found for the selected conditions. Showing fallback recommendations.'
            };
        }

        const payload = buildRecommendationApiPayload(datasetRecommendations, true);
        if (payload.recommendations.length) {
            return res.json(payload);
        }

        const emergencyFallback = buildCatalogRuleRecommendations({
            ...req.body,
            soilType: normalizedInput.soilType || 'Loamy',
            climate: normalizedInput.climate || 'Tropical',
            season: normalizedInput.season || 'Monsoon',
            waterAvailability: normalizedInput.waterAvailability || 'Medium',
            farmSize: normalizedInput.farmSize || 5,
            currentConditions: {
                temperature: normalizedInput.temperature || 28,
                humidity: normalizedInput.humidity || 75,
                soilMoisture: normalizedInput.soilMoisture || 60,
                pH: normalizedInput.ph || 6.5,
                rainfall: normalizedInput.rainfall || 120
            }
        }, MIN_RECOMMENDATION_RESULTS);
        return res.json(buildRecommendationApiPayload({
            ...emergencyFallback,
            message: 'Primary recommendation scoring returned no crops. Showing fallback recommendations.'
        }, true));

        const prompt = `
        ADVANCED AGRICULTURAL ANALYTICS ENGINE (NLP GENERATION):
        Based on the current farm parameters, provide a professional crop recommendation report.
        
        PARAMETERS:
        - Soil NPK: ${n}-${p}-${k}
        - Soil pH: ${ph}
        - Rainfall: ${rainfall}mm
        - Temperature: ${temperature}°C
        - Humidity: ${humidity}%
        - Soil Type: ${soilType}
        - Climate: ${climate}
        - Season: ${season}
        
        GOAL: Provide 8-10 diverse crop recommendations (including common, regional, and high-value exotic crops, fruits, and leafy greens) optimized for these parameters.
        IMPORTANT: Recommendations must vary with soil type, climate, season, water availability, rainfall, temperature, humidity, pH, and farm size. Avoid repeating the same small set of crops across different inputs.
        Prioritize a balanced mix of crop families when appropriate, rather than only returning the usual top 5 staples.
        
        FOR EACH CROP, PROVIDE:
        1. Common Name.
        2. Suitability Percentage (0-100%).
        3. Detailed Suitability Explanation (description): MUST BE 2-3 LINES LONG. Combine climate, soil, and moisture analysis into a professional summary. Format: "Crop thrives in [Temp/Humidity]... Current soil [Type/pH] provides ideal [Reason]... Expected behavior is [Analysis]."
        4. Condition Summary (Compact single line): e.g., "Temperature optimal, Soil moisture good, pH level suitable".
        5. Climate Suitability: Temp range and humidity levels.
        6. Soil Conditions: Ideal pH, moisture, and soil type.
        7. Water Requirements: Level and brief advice.
        8. Expected Yield Range and Unit.
        9. Current Market Value in INR.
        10. Profit Margin Percentage.
        11. Sustainability Score.
        12. Planting & Harvesting Seasons.
        13. Professional Image Prompt.
        
        RETURN STRICT JSON ONLY:
        {
            "analysisSummary": "A professional summary of why certain crops match these farm conditions.",
            "recommendations": [
                {
                    "crop": "Name",
                    "suitabilityScore": 90,
                    "description": "2-3 line explanation of suitability...",
                    "conditionSummary": "Temperature optimal, Soil moisture good, pH level suitable",
                    "climateDetails": { "tempRange": "20-30°C", "humidity": "60-70%" },
                    "soilDetails": { "ph": "6.0-7.0", "moisture": "Moderate", "type": "Loamy" },
                    "waterRequirements": { "level": "Medium", "advice": "Consistent moisture is key." },
                    "yieldRange": "25-35", "yieldUnit": "q/acre",
                    "marketValue": "₹1,95,000",
                    "profitMargin": "216.7%",
                    "sustainabilityScore": 85,
                    "plantingSeason": "June-July", 
                    "harvestingSeason": "October-November",
                    "imageKeyword": "detailed prompt for image search"
                }
            ]
        }`;

        const getSuitabilityLabel = (score) => {
            if (score >= 90) return 'Excellent';
            if (score >= 80) return 'High';
            if (score >= 70) return 'Moderate';
            return 'Low';
        };

        const normalizeText = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const hasAny = (text, terms) => terms.some(term => text.includes(term));
        const cropKey = (crop) => normalizeText(crop);
        const clampScore = (score) => Math.min(99, Math.max(10, Math.round(score)));
        const cropGroup = (crop) => {
            const c = cropKey(crop);
            if (hasAny(c, ['mushroom'])) return 'controlled';
            if (hasAny(c, ['rice', 'wheat', 'maize', 'barley', 'millet', 'ragi', 'bajra'])) return 'staple';
            if (hasAny(c, ['banana', 'coconut', 'mango', 'pineapple', 'dragon fruit', 'pomegranate', 'avocado', 'kiwi', 'blueberry', 'passion fruit', 'watermelon', 'strawberry', 'cherry'])) return 'fruit';
            if (hasAny(c, ['tomato', 'okra', 'carrot', 'radish', 'capsicum', 'garlic', 'potato', 'spinach', 'broccoli', 'onion'])) return 'vegetable';
            if (hasAny(c, ['cotton', 'sugarcane', 'turmeric', 'ginger', 'chilli', 'cumin', 'coriander', 'peppermint', 'lavender', 'black pepper', 'cardamom', 'clove', 'cinnamon'])) return 'spice';
            if (hasAny(c, ['cashew', 'almond', 'walnut', 'pistachio'])) return 'nut';
            return 'other';
        };
        const scoreMatches = (crop, terms, points) => hasAny(cropKey(crop), terms) ? points : 0;

        const geminiSystemPrompt = `You are an agricultural recommendation engine. Return only valid JSON that matches the requested schema. The recommendations must vary with the provided inputs and should not repeat the same crop family unless it is clearly the best fit.`;
        const cropRouterReply = await Promise.race([
            getAIResponse(prompt, [], false, null, geminiSystemPrompt, cropRecommendationApiKey),
            new Promise(resolve => setTimeout(() => resolve(null), 12000))
        ]);

        if (cropRouterReply) {
            try {
                const cleanReply = cropRouterReply.replace(/```json/g, '').replace(/```/g, '').trim();
                const data = JSON.parse(cleanReply);
                if (Array.isArray(data.recommendations)) {
                    data.recommendations = data.recommendations.map((item) => {
                        const score = Math.min(99, Math.max(10, Math.round(Number(item.suitabilityScore) || 0)));
                        return {
                            ...item,
                            suitabilityScore: score,
                            suitability: item.suitability || getSuitabilityLabel(score)
                        };
                    }).sort((a, b) => b.suitabilityScore - a.suitabilityScore).slice(0, 5);
                }
                return res.json(data);
            } catch (parseError) {
                console.warn('[CROP-AI] Dedicated OpenRouter response could not be parsed. Falling back to other generators.');
            }
        }

        const geminiReply = await Promise.race([
            getGeminiResponse(prompt, geminiSystemPrompt),
            new Promise(resolve => setTimeout(() => resolve(null), 12000))
        ]);

        if (!geminiReply) {
            const reply = await Promise.race([
                getAIResponse(prompt, [], false),
                new Promise(resolve => setTimeout(() => resolve(null), 12000))
            ]);
            if (!reply) {
            console.warn('[WARN] Crop Recommendation AI failed. Using Refined Fallback.');
            const fallbackRecs = [
                { 
                    crop: 'Rice (Paddy)', suitabilityScore: 92, 
                    description: 'Rice is perfectly suited for your soil with high moisture levels. It thrives in high temperatures (20-35°C) and the clay-rich soil on your farm provides ideal water retention for sustained growth. Expect high yield of 12-18 q/acre under current climate conditions.',
                    conditionSummary: 'Temperature optimal, Soil moisture excellent, pH level suitable',
                    climateDetails: { tempRange: '20-35°C', humidity: '70-90%' },
                    soilDetails: { ph: '5.5-7.0', moisture: 'High', type: 'Clay/Loam' },
                    waterRequirements: { level: 'High', advice: 'Maintain a 5cm water level during vegetative growth.' },
                    growthConditions: 'Thrives in flooded conditions with plenty of sunshine.',
                    yieldRange: '12-18', yieldUnit: 'q/acre', marketValue: '₹1,45,000', profitMargin: '185%', sustainabilityScore: 85,
                    plantingSeason: 'June-July', harvestingSeason: 'November-December',
                    imageKeyword: 'lush green rice paddy field'
                },
                { 
                    crop: 'Banana (G9 Variety)', suitabilityScore: 86, 
                    description: 'Profitable tropical fruit with high water requirements. Thrives in humid climates and nitrogen-rich soil on your farm. High market demand in the local district ensures strong ROI.',
                    conditionSummary: 'Temperature ideal, Humidity high, Nitrogen response excellent',
                    climateDetails: { tempRange: '25-30°C', humidity: '75-85%' },
                    soilDetails: { ph: '6.5-7.5', moisture: 'High', type: 'Rich Loam' },
                    waterRequirements: { level: 'High', advice: 'Heavy watering required; mulching helps retain moisture.' },
                    yieldRange: '40-50', yieldUnit: 'tons/acre', marketValue: '₹3,50,000', profitMargin: '250%', sustainabilityScore: 70,
                    plantingSeason: 'October-December', harvestingSeason: 'All-year (successive)',
                    imageKeyword: 'lush green banana trees with fruit'
                },
                { 
                    crop: 'Pomegranate', suitabilityScore: 91, 
                    description: 'High-value fruit for arid regions. Very drought tolerant once established and highly resistant to alkaline soil. Market demand is high for premium exports and value-added products.',
                    conditionSummary: 'Arid climate compatible, Soil pH tolerant, Water efficient',
                    climateDetails: { tempRange: '25-35°C', humidity: '40-50%' },
                    soilDetails: { ph: '6.5-8.5', moisture: 'Low', type: 'Sandy/Alluvial' },
                    waterRequirements: { level: 'Low', advice: 'Drip irrigation is sufficient; avoid overwatering near harvest.' },
                    yieldRange: '5-8', yieldUnit: 'tons/acre', marketValue: '₹4,20,000', profitMargin: '300%', sustainabilityScore: 90,
                    plantingSeason: 'June-August', harvestingSeason: 'December-February',
                    imageKeyword: 'ripe pomegranates on bush'
                },
                { 
                    crop: 'Vanilla Orchid', suitabilityScore: 71, 
                    description: 'Extreme high-value cash crop. Requires heavy shade and high humidity settings. labor intensive pollination but yields significant financial returns per square meter.',
                    conditionSummary: 'High value, Shade required, Labor intensive',
                    climateDetails: { tempRange: '21-32°C', humidity: '80-90%' },
                    soilDetails: { ph: '6.0-7.0', moisture: 'High', type: 'Humus Rich' },
                    waterRequirements: { level: 'High', advice: 'Consistent low-volume irrigation; avoid standing water.' },
                    yieldRange: '150-250', yieldUnit: 'kg/acre', marketValue: '₹8,50,000', profitMargin: '420%', sustainabilityScore: 88,
                    plantingSeason: 'August-September', harvestingSeason: 'August-September (3y)',
                    imageKeyword: 'vanilla orchid vine with green pods'
                },
                { 
                    crop: 'Okra (Ladyfinger)', suitabilityScore: 87, 
                    description: 'Fast-growing vegetable for warm climates. Provides continuous harvest and high fiber content. Highly responsive to organic manures and regular picking.',
                    conditionSummary: 'Heat tolerant, Fast growth, Continuous yield',
                    climateDetails: { tempRange: '25-35°C', humidity: '60-70%' },
                    soilDetails: { ph: '6.0-6.8', moisture: 'Moderate', type: 'Sandy Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Regular irrigation every 3-4 days in summer.' },
                    yieldRange: '4-6', yieldUnit: 'tons/acre', marketValue: '₹1,20,000', profitMargin: '220%', sustainabilityScore: 85,
                    plantingSeason: 'February-March', harvestingSeason: 'May-July',
                    imageKeyword: 'okra plant with long green pods'
                },
                { 
                    crop: 'Mushroom (Oyster)', suitabilityScore: 94, 
                    description: 'Indoor cultivation possible regardless of outdoor soil. High value with zero land usage if vertical. Perfect for adding revenue streams in small farming spaces.',
                    conditionSummary: 'Controlled environment, Zero land usage, High ROI',
                    climateDetails: { tempRange: '20-30°C', humidity: '80-90%' },
                    soilDetails: { ph: '6.5-7.5', moisture: 'High', type: 'Straw Substrate' },
                    waterRequirements: { level: 'Medium', advice: 'Mist-based humidity control is essential.' },
                    yieldRange: '12-18', yieldUnit: 'kg/sq.m', marketValue: '₹2,50,000', profitMargin: '450%', sustainabilityScore: 95,
                    plantingSeason: 'Year-round', harvestingSeason: 'Every 3-4 weeks',
                    imageKeyword: 'oyster mushrooms growing on straw bags'
                },
                { 
                    crop: 'Tomato', suitabilityScore: 88, 
                    description: 'Your sandy loam soil and moderate moisture are excellent for tomato cultivation. It thrives in 18-27°C, matching your current environment for high nutrient absorption and early fruit set. Predicted market returns remain very high for this variety.',
                    conditionSummary: 'Temperature ideal, Soil moisture good, pH level optimal',
                    climateDetails: { tempRange: '18-27°C', humidity: '60-70%' },
                    soilDetails: { ph: '6.0-7.0', moisture: 'Moderate', type: 'Sandy Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Consistent drip irrigation is recommended to avoid rot.' },
                    growthConditions: 'Needs well-drained soil and 6-8 hours of direct sunlight.',
                    yieldRange: '8-12', yieldUnit: 'tons/acre', marketValue: '₹1,80,000', profitMargin: '210%', sustainabilityScore: 80,
                    plantingSeason: 'October-November', harvestingSeason: 'January-February',
                    imageKeyword: 'ripe red tomatoes on vine'
                },
                { 
                    crop: 'Cotton', suitabilityScore: 84, 
                    description: 'Cotton is a strong match for your region as it thrives in warm temperatures (21-30°C) and moderate humidity. Your current soil pH ensures deep root development and healthy boll formation during the primary seasons.',
                    conditionSummary: 'Temperature optimal, Soil moisture medium, pH level suitable',
                    climateDetails: { tempRange: '21-30°C', humidity: '50-60%' },
                    soilDetails: { ph: '5.5-8.5', moisture: 'Low to Moderate', type: 'Black/Alluvial' },
                    waterRequirements: { level: 'Medium', advice: 'Avoid waterlogging during the flowering stage.' },
                    growthConditions: 'Requires a long frost-free period and bright sunshine.',
                    yieldRange: '8-12', yieldUnit: 'q/acre', marketValue: '₹2,15,000', profitMargin: '195%', sustainabilityScore: 60,
                    plantingSeason: 'May-June', harvestingSeason: 'October-December',
                    imageKeyword: 'white cotton bolls on plant'
                },
                { 
                    crop: 'Turmeric', suitabilityScore: 88, 
                    description: 'Highly profitable medicinal spice. Thrives in warm, humid climates with well-drained loamy soil and moderate rainfall. Excellent long-term storage potential for better market pricing.',
                    conditionSummary: 'Temperature optimal, Soil drainage good, Market value high',
                    climateDetails: { tempRange: '20-30°C', humidity: '70-90%' },
                    soilDetails: { ph: '4.5-7.5', moisture: 'Moderate', type: 'Loamy/Alluvial' },
                    waterRequirements: { level: 'Medium', advice: 'Avoid waterlogging; maintain consistent moisture during rhizome development.' },
                    yieldRange: '20-25', yieldUnit: 'q/acre', marketValue: '₹3,50,000', profitMargin: '280%', sustainabilityScore: 92,
                    plantingSeason: 'May-June', harvestingSeason: 'January-February',
                    imageKeyword: 'fresh turmeric rhizomes and plant'
                },
                { 
                    crop: 'Carrot', suitabilityScore: 78, 
                    description: 'Root vegetable for light, loose soils. Needs deep soil preparation and cool weather for sweetness. High demand in urban markets year-round.',
                    conditionSummary: 'Soil texture critical, Cool climate needed, Market demand steady',
                    climateDetails: { tempRange: '15-20°C', humidity: '60-70%' },
                    soilDetails: { ph: '6.0-7.0', moisture: 'Moderate', type: 'Sandy/Peaty' },
                    waterRequirements: { level: 'Medium', advice: 'Consistent moisture prevents root cracking and ensures uniform growth.' },
                    yieldRange: '8-12', yieldUnit: 'tons/acre', marketValue: '₹1,40,000', profitMargin: '160%', sustainabilityScore: 75,
                    plantingSeason: 'August-September', harvestingSeason: 'November-December',
                    imageKeyword: 'carrot tops in garden soil'
                },
                { 
                    crop: 'Ginger', suitabilityScore: 85, 
                    description: 'High-value rhizome crop. Best grown in partial shade with rich organic soil and excellent drainage. Highly resistant to many common pests.',
                    conditionSummary: 'Shade tolerant, Moisture sensitive, High ROI',
                    climateDetails: { tempRange: '25-30°C', humidity: '70-80%' },
                    soilDetails: { ph: '5.5-6.5', moisture: 'Moderate', type: 'Rich Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Keep soil moist but never soggy; mulching is highly beneficial.' },
                    yieldRange: '15-20', yieldUnit: 'q/acre', marketValue: '₹4,00,000', profitMargin: '320%', sustainabilityScore: 88,
                    plantingSeason: 'April-May', harvestingSeason: 'December-January',
                    imageKeyword: 'ginger plants with rhizomes visible'
                },
                { 
                    crop: 'Radish', suitabilityScore: 82, 
                    description: 'Short duration crop perfect for quick cash flow between major seasons. Grows well in sandy loam with moderate nitrogen levels.',
                    conditionSummary: 'Fast growth (40 days), Soil texture fine, Quick ROI',
                    climateDetails: { tempRange: '15-25°C', humidity: '50-70%' },
                    soilDetails: { ph: '5.5-6.8', moisture: 'Moderate', type: 'Sandy Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Regular watering prevents the root from becoming too pungent.' },
                    yieldRange: '5-7', yieldUnit: 'tons/acre', marketValue: '₹85,000', profitMargin: '140%', sustainabilityScore: 80,
                    plantingSeason: 'September-January', harvestingSeason: 'October-February',
                    imageKeyword: 'white radish roots in soil'
                },
                { 
                    crop: 'Capsicum (Bell Pepper)', suitabilityScore: 80, 
                    description: 'Premium vegetable for greenhouse or open field. High requirement for balanced NPK and specific temperature control for fruit set.',
                    conditionSummary: 'Temperature sensitive, Nutrient heavy, Market value premium',
                    climateDetails: { tempRange: '20-25°C', humidity: '60-70%' },
                    soilDetails: { ph: '6.0-7.0', moisture: 'Moderate', type: 'Loamy' },
                    waterRequirements: { level: 'Medium', advice: 'Drip irrigation is essential for consistent fruit quality.' },
                    yieldRange: '10-14', yieldUnit: 'tons/acre', marketValue: '₹2,80,000', profitMargin: '250%', sustainabilityScore: 78,
                    plantingSeason: 'September-October', harvestingSeason: 'December-February',
                    imageKeyword: 'colorful bell peppers on plant'
                },
                { 
                    crop: 'Garlic', suitabilityScore: 82, 
                    description: 'Valuable spice crop for well-drained soil. Long shelf life after harvest and high anti-microbial properties. Thrives in cool winter climates.',
                    conditionSummary: 'Soil drainage essential, High shelf life, Market stable',
                    climateDetails: { tempRange: '12-25°C', humidity: '50-60%' },
                    soilDetails: { ph: '6.0-7.5', moisture: 'Moderate', type: 'Clay/Sandy Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Reduce irrigation as the bulbs reach maturity to prevent rot.' },
                    yieldRange: '20-25', yieldUnit: 'q/acre', marketValue: '₹2,80,000', profitMargin: '190%', sustainabilityScore: 80,
                    plantingSeason: 'October-November', harvestingSeason: 'March-April',
                    imageKeyword: 'fresh garlic bulbs growing'
                },
                { 
                    crop: 'Potato', suitabilityScore: 84, 
                    description: 'Excellent match for loamy soil and cool nights. High yield potential with proper hilling and nitrogen management. Stable prices in local urban markets.',
                    conditionSummary: 'Temperature cool, Soil loamy, Hilling essential',
                    climateDetails: { tempRange: '15-20°C', humidity: '60-70%' },
                    soilDetails: { ph: '5.2-6.4', moisture: 'Moderate', type: 'Loamy' },
                    waterRequirements: { level: 'Medium', advice: 'Critical water period is during tuber initiation and bulking.' },
                    yieldRange: '20-25', yieldUnit: 'tons/acre', marketValue: '₹1,60,000', profitMargin: '170%', sustainabilityScore: 72,
                    plantingSeason: 'October-November', harvestingSeason: 'January-February',
                    imageKeyword: 'potato plants in hilled soil'
                },
                { 
                    crop: 'Black Pepper', suitabilityScore: 75, 
                    description: 'King of spices! Thrives in humid, tropical climates with high rainfall. Requires support trees or poles for climbing and rich organic soil.',
                    conditionSummary: 'Shade required, High humidity, Climbing support needed',
                    climateDetails: { tempRange: '20-30°C', humidity: '70-90%' },
                    soilDetails: { ph: '5.5-6.5', moisture: 'High', type: 'Red Laterite' },
                    waterRequirements: { level: 'High', advice: 'Needs well-distributed rainfall; sensitive to prolonged drought.' },
                    yieldRange: '500-800', yieldUnit: 'kg/acre', marketValue: '₹4,50,000', profitMargin: '380%', sustainabilityScore: 85,
                    plantingSeason: 'June-July', harvestingSeason: 'January-March',
                    imageKeyword: 'black pepper vines with green berries'
                },
                { 
                    crop: 'Cardamom (Green)', suitabilityScore: 72, 
                    description: 'Queen of spices. Grown in high-altitude evergreen forests under natural shade. Requires high humidity and very specific acidic soil conditions.',
                    conditionSummary: 'High altitude, Natural shade, Acidic soil',
                    climateDetails: { tempRange: '15-25°C', humidity: '75-85%' },
                    soilDetails: { ph: '4.5-5.8', moisture: 'High', type: 'Forest Loam' },
                    waterRequirements: { level: 'High', advice: 'Requires consistent moisture; overhead irrigation helps in dry spells.' },
                    yieldRange: '200-300', yieldUnit: 'kg/acre', marketValue: '₹6,50,000', profitMargin: '450%', sustainabilityScore: 90,
                    plantingSeason: 'June-August', harvestingSeason: 'September-February',
                    imageKeyword: 'green cardamom pods on plant base'
                },
                { 
                    crop: 'Mango (Alphonso)', suitabilityScore: 82, 
                    description: 'King of fruits! Thrives in well-drained deep soil with a distinct dry season for flowering. Premium variety with massive export potential.',
                    conditionSummary: 'Dry season needed, Deep soil, Export potential',
                    climateDetails: { tempRange: '25-35°C', humidity: '50-60%' },
                    soilDetails: { ph: '5.5-7.5', moisture: 'Low', type: 'Laterite/Alluvial' },
                    waterRequirements: { level: 'Low', advice: 'Water young trees regularly; mature trees are drought-tolerant.' },
                    yieldRange: '5-8', yieldUnit: 'tons/acre', marketValue: '₹5,50,000', profitMargin: '320%', sustainabilityScore: 75,
                    plantingSeason: 'July-August', harvestingSeason: 'April-June',
                    imageKeyword: 'ripe alphonso mangoes on tree'
                },
                { 
                    crop: 'Dragon Fruit', suitabilityScore: 88, 
                    description: 'Cactus-based exotic fruit. Very high water efficiency and drought tolerance. Requires concrete pole support but offers premium returns in urban markets.',
                    conditionSummary: 'Cactus type, Low water, Vertical support',
                    climateDetails: { tempRange: '20-40°C', humidity: '40-60%' },
                    soilDetails: { ph: '6.0-7.0', moisture: 'Low', type: 'Sandy Loam' },
                    waterRequirements: { level: 'Low', advice: 'Excellent for drip irrigation; sensitive to waterlogging.' },
                    yieldRange: '4-6', yieldUnit: 'tons/acre', marketValue: '₹8,00,000', profitMargin: '550%', sustainabilityScore: 95,
                    plantingSeason: 'June-July', harvestingSeason: 'June-November',
                    imageKeyword: 'dragon fruit cactus on concrete pole'
                },
                { 
                    crop: 'Passion Fruit', suitabilityScore: 79, 
                    description: 'High-value aromatic fruit vine. Thrives in sub-tropical climates with moderate rainfall. Excellent for juice and processing industries.',
                    conditionSummary: 'Vining crop, Sub-tropical, High aroma',
                    climateDetails: { tempRange: '18-30°C', humidity: '60-70%' },
                    soilDetails: { ph: '6.5-7.5', moisture: 'Moderate', type: 'Well-drained Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Needs regular watering during fruit development.' },
                    yieldRange: '6-9', yieldUnit: 'tons/acre', marketValue: '₹3,20,000', profitMargin: '290%', sustainabilityScore: 80,
                    plantingSeason: 'April-May', harvestingSeason: 'August-December',
                    imageKeyword: 'purple passion fruit on vine'
                },
                { 
                    crop: 'Tea (Highland)', suitabilityScore: 70, 
                    description: 'Classic plantation crop. Requires cool climate, high rainfall, and well-drained acidic soil on slopes. Labor intensive harvest but stable industry.',
                    conditionSummary: 'Slope cultivation, Acidic soil, Cool climate',
                    climateDetails: { tempRange: '13-21°C', humidity: '70-90%' },
                    soilDetails: { ph: '4.5-5.5', moisture: 'High', type: 'Forest Soils' },
                    waterRequirements: { level: 'High', advice: 'Requires frequent light showers; misting is beneficial.' },
                    yieldRange: '1500-2500', yieldUnit: 'kg/acre', marketValue: '₹3,80,000', profitMargin: '210%', sustainabilityScore: 85,
                    plantingSeason: 'June-July', harvestingSeason: 'April-December',
                    imageKeyword: 'tea plantation on mountain slopes'
                },
                { 
                    crop: 'Cocoa', suitabilityScore: 72, 
                    description: 'Shade-loving tropical crop. Best as intercrop in coconut or areca nut plantations. Growing demand for artisanal chocolate industry.',
                    conditionSummary: 'Shade required, Intercropping ideal, High demand',
                    climateDetails: { tempRange: '21-32°C', humidity: '70-80%' },
                    soilDetails: { ph: '6.5-7.5', moisture: 'High', type: 'Alluvial Loam' },
                    waterRequirements: { level: 'High', advice: 'Soil should always be moist; benefits from organic mulching.' },
                    yieldRange: '500-800', yieldUnit: 'kg/acre', marketValue: '₹2,60,000', profitMargin: '240%', sustainabilityScore: 90,
                    plantingSeason: 'May-June', harvestingSeason: 'September-January',
                    imageKeyword: 'cocoa pods on tree trunk'
                },
                { 
                    crop: 'Saffron', suitabilityScore: 65, 
                    description: 'Word\'s most expensive spice! Requires very specific temperate climate with cold winters and dry summers. Rare and extremely high value.',
                    conditionSummary: 'Extreme value, Temperate climate, Precision labor',
                    climateDetails: { tempRange: '-5-25°C', humidity: '40-50%' },
                    soilDetails: { ph: '6.0-8.0', moisture: 'Low', type: 'Calcareous Loam' },
                    waterRequirements: { level: 'Low', advice: 'Very minimal water needed; avoid irrigation in humid months.' },
                    yieldRange: '2-3', yieldUnit: 'kg/acre', marketValue: '₹15,00,000', profitMargin: '850%', sustainabilityScore: 95,
                    plantingSeason: 'August-September', harvestingSeason: 'October-November',
                    imageKeyword: 'purple saffron crocus flowers'
                },
                { 
                    crop: 'Rubber', suitabilityScore: 68, 
                    description: 'Long-term plantation investment. Thrives in heavy rainfall areas with deep soil. Tapping starts after 7 years for consistent long-term cash flow.',
                    conditionSummary: 'Long-term, Heavy rainfall, Consistent yield',
                    climateDetails: { tempRange: '25-34°C', humidity: '80-90%' },
                    soilDetails: { ph: '4.5-6.0', moisture: 'High', type: 'Laterite' },
                    waterRequirements: { level: 'High', advice: 'Requires high atmospheric humidity more than irrigation.' },
                    yieldRange: '600-900', yieldUnit: 'kg/acre', marketValue: '₹1,50,000', profitMargin: '120%', sustainabilityScore: 80,
                    plantingSeason: 'June-July', harvestingSeason: 'Year-round tapping',
                    imageKeyword: 'latex collection from rubber tree'
                },
                { 
                    crop: 'Cashew', suitabilityScore: 85, 
                    description: 'Highly resilient tree crop for waste lands. Drought tolerant and improves soil structure. Low maintenance with high export value for nuts.',
                    conditionSummary: 'Waste land suitable, Low maintenance, Drought tolerant',
                    climateDetails: { tempRange: '20-30°C', humidity: '60-70%' },
                    soilDetails: { ph: '5.0-8.0', moisture: 'Low', type: 'Sandy/Laterite' },
                    waterRequirements: { level: 'Low', advice: 'Only young saplings need watering; mature trees survive on rain.' },
                    yieldRange: '800-1200', yieldUnit: 'kg/acre', marketValue: '₹1,20,000', profitMargin: '180%', sustainabilityScore: 85,
                    plantingSeason: 'June-August', harvestingSeason: 'February-May',
                    imageKeyword: 'cashew apple and nut on branch'
                },
                { 
                    crop: 'Watermelon', suitabilityScore: 84, 
                    description: 'Ideal summer crop for sandy river beds. Fast growth (90 days) with high market demand during hot months. Water-intensive but highly profitable.',
                    conditionSummary: 'Summer crop, Fast growth, High water need',
                    climateDetails: { tempRange: '25-35°C', humidity: '50-60%' },
                    soilDetails: { ph: '6.0-7.0', moisture: 'Medium', type: 'Sandy Bed' },
                    waterRequirements: { level: 'High', advice: 'Frequent light irrigation is better than heavy flooding.' },
                    yieldRange: '15-20', yieldUnit: 'tons/acre', marketValue: '₹80,000', profitMargin: '150%', sustainabilityScore: 70,
                    plantingSeason: 'January-February', harvestingSeason: 'April-May',
                    imageKeyword: 'large watermelons in field'
                },
                { 
                    crop: 'Strawberry', suitabilityScore: 75, 
                    description: 'Premium berry for cool climates or polyhouse setups. High sensitivity to soil pH and salinity. Very high margin in niche retail markets.',
                    conditionSummary: 'Cool nights required, pH sensitive, High margin',
                    climateDetails: { tempRange: '15-25°C', humidity: '50-60%' },
                    soilDetails: { ph: '5.5-6.5', moisture: 'Moderate', type: 'Sandy Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Drip irrigation with fertigation is highly recommended.' },
                    yieldRange: '4-6', yieldUnit: 'tons/acre', marketValue: '₹3,50,000', profitMargin: '300%', sustainabilityScore: 78,
                    plantingSeason: 'September-October', harvestingSeason: 'December-March',
                    imageKeyword: 'ripe strawberries in basket'
                },
                { 
                    crop: 'Spinach', suitabilityScore: 92, 
                    description: 'Superfast short-duration leafy green. Possible to harvest every 30 days. High demand for organic varieties in city centers.',
                    conditionSummary: 'Superfast harvest, Nutrient rich, Urban demand',
                    climateDetails: { tempRange: '10-25°C', humidity: '60-70%' },
                    soilDetails: { ph: '6.5-7.5', moisture: 'Moderate', type: 'Sandy/Silty Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Light misting keeps leaves fresh and crisp.' },
                    yieldRange: '2-4', yieldUnit: 'tons/acre', marketValue: '₹40,000', profitMargin: '110%', sustainabilityScore: 95,
                    plantingSeason: 'All-year', harvestingSeason: '30-45 days after sowing',
                    imageKeyword: 'lush green spinach bed'
                },
                { 
                    crop: 'Broccoli', suitabilityScore: 78, 
                    description: 'Exotic cruciferous vegetable for winter. High requirement for sulfur-based nutrients and consistent moisture level.',
                    conditionSummary: 'Winter specific, Nutrient heavy, Health food market',
                    climateDetails: { tempRange: '15-21°C', humidity: '60-70%' },
                    soilDetails: { ph: '6.0-7.0', moisture: 'Moderate', type: 'Deep Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Keep soil evenly moist to prevent early bolting.' },
                    yieldRange: '3-5', yieldUnit: 'tons/acre', marketValue: '₹1,50,000', profitMargin: '190%', sustainabilityScore: 85,
                    plantingSeason: 'September-November', harvestingSeason: 'December-February',
                    imageKeyword: 'broccoli head in garden'
                },
                { 
                    crop: 'Clove', suitabilityScore: 70, 
                    description: 'Valuable spice bud. Requires humid tropical climate with moderate but well-distributed rainfall. Tree starts bearing after 7-8 years.',
                    conditionSummary: 'Long-term tree, Spice value, Humidity need',
                    climateDetails: { tempRange: '20-30°C', humidity: '70-90%' },
                    soilDetails: { ph: '5.0-6.0', moisture: 'High', type: 'Red/Laterite' },
                    waterRequirements: { level: 'High', advice: 'Soil should have high organic content to retain moisture.' },
                    yieldRange: '2-3', yieldUnit: 'kg/tree', marketValue: '₹4,00,000', profitMargin: '350%', sustainabilityScore: 92,
                    plantingSeason: 'June-July', harvestingSeason: 'September-January',
                    imageKeyword: 'clove flower buds on branch'
                },
                { 
                    crop: 'Cinnamon', suitabilityScore: 75, 
                    description: 'Bark-based spice. Thrives in sandy-loam soils with high organic matter. Periodic pruning allows for continuous bark harvest.',
                    conditionSummary: 'Bark harvest, Organic soil, Low pest issues',
                    climateDetails: { tempRange: '25-30°C', humidity: '70-80%' },
                    soilDetails: { ph: '4.5-5.5', moisture: 'High', type: 'Sandy Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Sensitive to stagnant water; needs perfect drainage.' },
                    yieldRange: '100-150', yieldUnit: 'kg/acre', marketValue: '₹1,80,000', profitMargin: '220%', sustainabilityScore: 88,
                    plantingSeason: 'June-July', harvestingSeason: 'May-November',
                    imageKeyword: 'cinnamon bark being peeled'
                },
                { 
                    crop: 'Mulberry (Sericulture)', suitabilityScore: 86, 
                    description: 'Drought-tolerant tree grown primarily for silkworm rearing. Very high sustainability score and continuous foliage harvest.',
                    conditionSummary: 'Drought tolerant, Continuous foliage, Sericulture base',
                    climateDetails: { tempRange: '20-35°C', humidity: '60-70%' },
                    soilDetails: { ph: '6.2-6.8', moisture: 'Moderate', type: 'Alluvial Loam' },
                    waterRequirements: { level: 'Low', advice: 'Needs deep pruning twice a year to maintain foliage quality.' },
                    yieldRange: '10-15', yieldUnit: 'tons/acre', marketValue: '₹90,000', profitMargin: '130%', sustainabilityScore: 98,
                    plantingSeason: 'June-August', harvestingSeason: 'Successive leaf picking',
                    imageKeyword: 'mulberry leaves with silkworms'
                },
                { 
                    crop: 'Avocado (Hass)', suitabilityScore: 74, 
                    description: 'Superfood with booming internal demand. Requires well-drained volcanic or loamy soil and protection from frost. High sustainability with long productive life.',
                    conditionSummary: 'Well-draining vital, Frost sensitive, Long life cycle',
                    climateDetails: { tempRange: '20-28°C', humidity: '60-70%' },
                    soilDetails: { ph: '6.0-7.0', moisture: 'Moderate', type: 'Volcanic Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Sensitive to saline water and root rot; ensure perfect drainage.' },
                    yieldRange: '4-6', yieldUnit: 'tons/acre', marketValue: '₹7,50,000', profitMargin: '480%', sustainabilityScore: 88,
                    plantingSeason: 'June-July', harvestingSeason: 'October-January (after 3y)',
                    imageKeyword: 'ripe avocado fruit on branch'
                },
                { 
                    crop: 'Kiwi (Green)', suitabilityScore: 68, 
                    description: 'High-value vining fruit. Requires cool temperatures with specific chilling hours during winter for fruit set. High demand in premium urban markets.',
                    conditionSummary: 'Specific chilling hours, Vining support, High urban value',
                    climateDetails: { tempRange: '13-24°C', humidity: '60-75%' },
                    soilDetails: { ph: '5.5-6.5', moisture: 'High', type: 'Deep Sandy Loam' },
                    waterRequirements: { level: 'High', advice: 'Soil should never dry out completely during summer.' },
                    yieldRange: '3-5', yieldUnit: 'tons/acre', marketValue: '₹6,00,000', profitMargin: '350%', sustainabilityScore: 82,
                    plantingSeason: 'January-February', harvestingSeason: 'October-November (after 4y)',
                    imageKeyword: 'kiwi fruits hanging from vine trellis'
                },
                { 
                    crop: 'Blueberry (Northern Highbush)', suitabilityScore: 65, 
                    description: 'Premium berry requiring very acidic soil conditions. Best grown in pots or specially prepared beds with peat moss and pine bark.',
                    conditionSummary: 'Very acidic soil, High moisture, Specialized setup',
                    climateDetails: { tempRange: '15-25°C', humidity: '60-70%' },
                    soilDetails: { ph: '4.5-5.2', moisture: 'High', type: 'Acidic Peat' },
                    waterRequirements: { level: 'High', advice: 'Requires consistent drip irrigation with balanced pH water.' },
                    yieldRange: '2-4', yieldUnit: 'kg/bush', marketValue: '₹12,00,000', profitMargin: '650%', sustainabilityScore: 80,
                    plantingSeason: 'February-March', harvestingSeason: 'June-August (after 2y)',
                    imageKeyword: 'blueberries ripening on bush'
                },
                { 
                    crop: 'Almond (Premium)', suitabilityScore: 76, 
                    description: 'High-value nut crop for dry regions with cool winters. Requires honeybee pollination for good fruit set. Very high durability and storage value.',
                    conditionSummary: 'Dry climate, Pollination dependent, High durability',
                    climateDetails: { tempRange: '15-32°C', humidity: '40-50%' },
                    soilDetails: { ph: '7.0-8.5', moisture: 'Low', type: 'Sandy/Calcareous' },
                    waterRequirements: { level: 'Low', advice: 'Minimal water during summer; avoid humidity during flowering.' },
                    yieldRange: '1000-1500', yieldUnit: 'kg/acre', marketValue: '₹5,80,000', profitMargin: '290%', sustainabilityScore: 85,
                    plantingSeason: 'January-February', harvestingSeason: 'August-October',
                    imageKeyword: 'almond blossoms and green nuts'
                },
                { 
                    crop: 'Walnut (English)', suitabilityScore: 70, 
                    description: 'Long-term investment for high-altitude regions. Deep root system requires deep, well-aerated soil. Premium pricing for high-quality kernels.',
                    conditionSummary: 'High altitude, Deep soil needed, Long-term gain',
                    climateDetails: { tempRange: '10-25°C', humidity: '50-60%' },
                    soilDetails: { ph: '6.0-7.5', moisture: 'Moderate', type: 'Deep Silt Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Water deeply during dry spells; sensitive to waterlogging.' },
                    yieldRange: '1.5-2', yieldUnit: 'tons/acre', marketValue: '₹4,20,000', profitMargin: '210%', sustainabilityScore: 92,
                    plantingSeason: 'January-March', harvestingSeason: 'September-November',
                    imageKeyword: 'walnuts in green husks on tree'
                },
                { 
                    crop: 'Pistachio', suitabilityScore: 82, 
                    description: 'Extremely drought and salt tolerant nut tree. Requires distinct hot dry summers and cool winters. Possible to grow on saline/alkaline soils where other crops fail.',
                    conditionSummary: 'Saline tolerant, Drought champion, Salt tolerance',
                    climateDetails: { tempRange: '25-45°C', humidity: '20-40%' },
                    soilDetails: { ph: '7.0-9.0', moisture: 'Extremely Low', type: 'Saline/Sandy' },
                    waterRequirements: { level: 'Extremely Low', advice: 'Requires very little irrigation once established.' },
                    yieldRange: '800-1200', yieldUnit: 'kg/acre', marketValue: '₹8,50,000', profitMargin: '380%', sustainabilityScore: 96,
                    plantingSeason: 'February-March', harvestingSeason: 'September-October',
                    imageKeyword: 'pistachio nuts ripening in clusters'
                },
                { 
                    crop: 'Cherry (Sweet)', suitabilityScore: 62, 
                    description: 'Boutique fruit for cold mountain regions. Requires high chilling hours and protection from rain during harvest to prevent skin splitting.',
                    conditionSummary: 'Cold mountain crop, Rain sensitive, Premium niche',
                    climateDetails: { tempRange: '10-22°C', humidity: '50-60%' },
                    soilDetails: { ph: '6.0-7.0', moisture: 'Moderate', type: 'Well-drained Loam' },
                    waterRequirements: { level: 'Medium', advice: 'Consistent moisture is vital during fruit development.' },
                    yieldRange: '3-4', yieldUnit: 'tons/acre', marketValue: '₹9,50,000', profitMargin: '500%', sustainabilityScore: 75,
                    plantingSeason: 'January-February', harvestingSeason: 'May-June',
                    imageKeyword: 'red cherries on tree branch'
                },
                { 
                    crop: 'Millet (Ragi/Finger)', suitabilityScore: 95, 
                    description: 'Nutritional powerhouse and climate-smart cereal. Highly resistant to drought and pests. Stable yield with minimal chemical fertilizers.',
                    conditionSummary: 'Climate smart, Low input, Pesticide free',
                    climateDetails: { tempRange: '25-35°C', humidity: '40-60%' },
                    soilDetails: { ph: '5.0-8.2', moisture: 'Low', type: 'Red/Laterite' },
                    waterRequirements: { level: 'Low', advice: 'Can survive several weeks of drought during vegetative stage.' },
                    yieldRange: '8-12', yieldUnit: 'q/acre', marketValue: '₹45,000', profitMargin: '120%', sustainabilityScore: 99,
                    plantingSeason: 'June-July', harvestingSeason: 'October-November',
                    imageKeyword: 'ragi crop heads in field'
                },
                { 
                    crop: 'Millet (Bajra/Pearl)', suitabilityScore: 94, 
                    description: 'Champion of arid zones! Can produce grain on very low soil fertility and minimal rainfall. High demand for gluten-free health food markets.',
                    conditionSummary: 'Arid zone champion, Low fertility, Gluten free',
                    climateDetails: { tempRange: '30-45°C', humidity: '20-40%' },
                    soilDetails: { ph: '7.0-8.5', moisture: 'Extremely Low', type: 'Sandy/Arid' },
                    waterRequirements: { level: 'Extremely Low', advice: 'Resistant to high heat; needs well-aerated sandy soil.' },
                    yieldRange: '10-14', yieldUnit: 'q/acre', marketValue: '₹42,000', profitMargin: '140%', sustainabilityScore: 98,
                    plantingSeason: 'July-August', harvestingSeason: 'October-December',
                    imageKeyword: 'bajra pearl millet in desert field'
                },
                { 
                    crop: 'Barley (Malting)', suitabilityScore: 78, 
                    description: 'Salt-tolerant cereal with high demand from brewing and animal feed industries. Shorter growing season than wheat, making it a flexible second crop.',
                    conditionSummary: 'Salt tolerant, Industrial demand, Fast growing',
                    climateDetails: { tempRange: '15-28°C', humidity: '40-50%' },
                    soilDetails: { ph: '6.0-8.0', moisture: 'Moderate', type: 'Loamy/Silty' },
                    waterRequirements: { level: 'Medium', advice: 'Avoid overhead irrigation during flowering to stay disease-free.' },
                    yieldRange: '12-16', yieldUnit: 'q/acre', marketValue: '₹38,000', profitMargin: '110%', sustainabilityScore: 82,
                    plantingSeason: 'October-November', harvestingSeason: 'March-April',
                    imageKeyword: 'golden barley heads'
                },
                { 
                    crop: 'Lavender', suitabilityScore: 84, 
                    description: 'Aromatic medicinal plant with massive demand from essential oil and cosmetic industries. Highly drought tolerant once established and survives in poor soils.',
                    conditionSummary: 'Oil value, Poor soil suitable, Drought champion',
                    climateDetails: { tempRange: '20-35°C', humidity: '30-50%' },
                    soilDetails: { ph: '6.5-8.5', moisture: 'Low', type: 'Sandy/Calcareous' },
                    waterRequirements: { level: 'Low', advice: 'Excellent drainage is vital; susceptible to root rot if wet.' },
                    yieldRange: '15-20', yieldUnit: 'kg/acre (oil)', marketValue: '₹5,00,000', profitMargin: '420%', sustainabilityScore: 98,
                    plantingSeason: 'November-December', harvestingSeason: 'June-July',
                    imageKeyword: 'purple lavender field'
                },
                { 
                    crop: 'Peppermint', suitabilityScore: 88, 
                    description: 'Fast-growing herb for essential oil. Requires constant moisture and organic-rich soil. Continuous harvesting possible during the growing season.',
                    conditionSummary: 'Essential oil, Fast growth, High moisture',
                    climateDetails: { tempRange: '20-30°C', humidity: '70-80%' },
                    soilDetails: { ph: '6.0-7.0', moisture: 'High', type: 'Rich Alluvial' },
                    waterRequirements: { level: 'High', advice: 'Needs soil to be consistently wet; mulch helps significantly.' },
                    yieldRange: '20-30', yieldUnit: 'kg/acre (oil)', marketValue: '₹3,20,000', profitMargin: '350%', sustainabilityScore: 90,
                    plantingSeason: 'February-March', harvestingSeason: 'Successive harvesting',
                    imageKeyword: 'fresh mint leaf field'
                },
                { 
                    crop: 'Coriander (Seed)', suitabilityScore: 86, 
                    description: 'Dual-purpose spice and herb. Fast duration (90 days). Thrives in well-distributed light rainfall and loamy soil. Growing export demand for seeds.',
                    conditionSummary: 'Short duration, Export potential, Dual purpose',
                    climateDetails: { tempRange: '18-28°C', humidity: '50-60%' },
                    soilDetails: { ph: '6.0-7.5', moisture: 'Moderate', type: 'Loamy' },
                    waterRequirements: { level: 'Medium', advice: 'Maintain soil moisture during flowering and seed set.' },
                    yieldRange: '400-600', yieldUnit: 'kg/acre', marketValue: '₹1,20,000', profitMargin: '210%', sustainabilityScore: 85,
                    plantingSeason: 'October-November', harvestingSeason: 'January-February',
                    imageKeyword: 'coriander seed production field'
                },
                { 
                    crop: 'Cumin (Spice)', suitabilityScore: 72, 
                    description: 'Extremely high value but sensitive spice. Requires cold dry winters and sandy soil. High sensitivity to frost and excessive humidity at harvest.',
                    conditionSummary: 'Sensitivity high, Cold dry winter, High market value',
                    climateDetails: { tempRange: '15-25°C', humidity: '20-40%' },
                    soilDetails: { ph: '7.0-8.5', moisture: 'Extremely Low', type: 'Sandy Loam' },
                    waterRequirements: { level: 'Low', advice: 'Apply only minimal irrigation; susceptible to wilt.' },
                    yieldRange: '300-500', yieldUnit: 'kg/acre', marketValue: '₹4,50,000', profitMargin: '380%', sustainabilityScore: 82,
                    plantingSeason: 'November-December', harvestingSeason: 'February-March',
                    imageKeyword: 'cumin spice plants in arid field'
                }
            ];

            // --- INTELLECTUAL DYNAMIC LOGIC ENGINE (OFFLINE FALLBACK) ---
            // Even if AI hits quota, we re-calculate suitability based on LIVE parameters
            const soil = normalizeText(soilType);
            const climateNorm = normalizeText(climate);
            const seasonNorm = normalizeText(season);
            const waterNorm = normalizeText(waterAvailability);
            const tempVal = Number(temperature) || 0;
            const rainVal = Number(rainfall) || 0;
            const humVal = Number(humidity) || 0;
            const phVal = Number(ph) || 6.5;
            const farmClass = farmSize <= 2 ? 'small' : farmSize <= 6 ? 'medium' : 'large';

            const scoreCrop = (rec) => {
                const key = cropKey(rec.crop);
                let score = rec.suitabilityScore;

                // Soil signals
                if (hasAny(soil, ['clay', 'alluvial', 'loam', 'black soil', 'silty'])) {
                    score += scoreMatches(rec.crop, ['rice', 'paddy', 'banana', 'sugarcane', 'spinach', 'tomato', 'maize', 'turmeric', 'mushroom', 'pepper', 'coconut'], 10);
                    score += scoreMatches(rec.crop, ['wheat', 'barley', 'potato', 'onion', 'garlic', 'carrot', 'broccoli'], 4);
                }
                if (hasAny(soil, ['sandy', 'arid', 'red sandy', 'laterite', 'red soil', 'dry'])) {
                    score += scoreMatches(rec.crop, ['bajra', 'ragi', 'millet', 'barley', 'cumin', 'lavender', 'pistachio', 'dragon fruit', 'watermelon', 'groundnut', 'cotton', 'cashew'], 10);
                    score += scoreMatches(rec.crop, ['rice', 'banana', 'mushroom', 'spinach'], -8);
                }
                if (hasAny(soil, ['acid', 'acidic', 'peat', 'forest', 'volcanic'])) {
                    score += scoreMatches(rec.crop, ['tea', 'cocoa', 'pepper', 'pineapple', 'ginger', 'turmeric', 'potato', 'blueberry', 'strawberry', 'kiwi'], 10);
                }
                if (hasAny(soil, ['alkaline', 'calcareous', 'saline'])) {
                    score += scoreMatches(rec.crop, ['bajra', 'barley', 'cumin', 'pistachio', 'cotton', 'groundnut', 'millet'], 9);
                }

                // Climate and seasonal signals
                if (hasAny(climateNorm, ['tropical', 'humid', 'monsoon'])) {
                    score += scoreMatches(rec.crop, ['rice', 'banana', 'coconut', 'sugarcane', 'pepper', 'cocoa', 'turmeric', 'mushroom', 'spinach'], 9);
                }
                if (hasAny(climateNorm, ['arid', 'dry', 'semi arid', 'semiarid'])) {
                    score += scoreMatches(rec.crop, ['bajra', 'ragi', 'millet', 'cumin', 'lavender', 'pistachio', 'dragon fruit', 'watermelon', 'cotton', 'cashew'], 11);
                }
                if (hasAny(climateNorm, ['cool', 'temperate', 'winter', 'highland'])) {
                    score += scoreMatches(rec.crop, ['wheat', 'barley', 'potato', 'onion', 'garlic', 'carrot', 'broccoli', 'strawberry', 'kiwi', 'cherry', 'blueberry', 'almond', 'walnut'], 11);
                }

                if (hasAny(seasonNorm, ['monsoon', 'rainy'])) {
                    score += scoreMatches(rec.crop, ['rice', 'banana', 'sugarcane', 'maize', 'turmeric', 'mushroom', 'pepper'], 8);
                }
                if (hasAny(seasonNorm, ['winter', 'rabi'])) {
                    score += scoreMatches(rec.crop, ['wheat', 'barley', 'potato', 'onion', 'garlic', 'carrot', 'broccoli', 'strawberry'], 9);
                }
                if (hasAny(seasonNorm, ['summer', 'kharif'])) {
                    score += scoreMatches(rec.crop, ['cotton', 'watermelon', 'dragon fruit', 'okra', 'bajra', 'ragi', 'millet', 'pomegranate', 'maize'], 8);
                }

                if (hasAny(waterNorm, ['high', 'ample', 'abundant'])) {
                    score += scoreMatches(rec.crop, ['rice', 'banana', 'sugarcane', 'spinach', 'mushroom', 'pepper', 'tomato', 'turmeric'], 9);
                }
                if (hasAny(waterNorm, ['medium', 'moderate'])) {
                    score += scoreMatches(rec.crop, ['tomato', 'maize', 'cotton', 'groundnut', 'ginger', 'okra', 'coriander', 'pomegranate'], 7);
                }
                if (hasAny(waterNorm, ['low', 'scarce', 'limited'])) {
                    score += scoreMatches(rec.crop, ['bajra', 'ragi', 'barley', 'cumin', 'lavender', 'pistachio', 'dragon fruit', 'groundnut', 'cashew', 'millet'], 10);
                }

                // Numeric climate signals
                if (rainVal > 300) {
                    score += scoreMatches(rec.crop, ['rice', 'sugarcane', 'banana', 'cocoa', 'pepper', 'tea', 'mushroom', 'spinach', 'peppermint', 'blueberry'], 8);
                } else if (rainVal < 100) {
                    score += scoreMatches(rec.crop, ['cotton', 'chilli', 'pomegranate', 'dragon fruit', 'cashew', 'mulberry', 'millet', 'bajra', 'ragi', 'pistachio', 'lavender', 'cumin', 'almond'], 10);
                }

                if (tempVal > 35) {
                    score += scoreMatches(rec.crop, ['cotton', 'sugarcane', 'pomegranate', 'dragon fruit', 'watermelon', 'millet', 'bajra', 'ragi', 'pistachio', 'okra'], 8);
                } else if (tempVal < 20) {
                    score += scoreMatches(rec.crop, ['wheat', 'barley', 'potato', 'onion', 'garlic', 'broccoli', 'carrot', 'kiwi', 'cherry', 'blueberry', 'almond', 'walnut', 'strawberry'], 10);
                }

                if (humVal >= 75) {
                    score += scoreMatches(rec.crop, ['rice', 'banana', 'sugarcane', 'mushroom', 'pepper', 'tea', 'cocoa', 'peppermint'], 7);
                }

                if (phVal < 6.2) {
                    score += scoreMatches(rec.crop, ['tea', 'coffee', 'blueberry', 'pineapple', 'potato', 'ginger', 'turmeric', 'strawberry'], 8);
                } else if (phVal > 7.2) {
                    score += scoreMatches(rec.crop, ['bajra', 'barley', 'cumin', 'pistachio', 'cotton', 'groundnut', 'millet'], 8);
                }

                // NPK signals
                const n_val = parseFloat(n) || 80;
                const p_val = parseFloat(p) || 40;
                const k_val = parseFloat(k) || 40;

                if (n_val < 50) {
                    score += scoreMatches(rec.crop, ['black gram', 'soybean', 'groundnut', 'millet', 'pistachio', 'cashew'], 10);
                }
                if (n_val > 100) {
                    score += scoreMatches(rec.crop, ['rice', 'sugarcane', 'maize', 'banana', 'tomato', 'spinach'], 8);
                }
                if (k_val > 60) {
                    score += scoreMatches(rec.crop, ['banana', 'tomato', 'grapes', 'potato', 'ginger', 'turmeric', 'pomegranate'], 8);
                }
                if (p_val > 50) {
                    score += scoreMatches(rec.crop, ['wheat', 'onion', 'garlic', 'carrot', 'broccoli'], 6);
                }

                // Farm-size and crop-type balancing
                if (farmClass === 'small') {
                    score += scoreMatches(rec.crop, ['mushroom', 'spinach', 'tomato', 'ginger', 'turmeric', 'coriander', 'peppermint', 'strawberry'], 8);
                    score -= scoreMatches(rec.crop, ['rice', 'sugarcane', 'wheat', 'maize'], 3);
                } else if (farmClass === 'large') {
                    score += scoreMatches(rec.crop, ['rice', 'wheat', 'maize', 'sugarcane', 'cotton', 'millet', 'banana'], 6);
                }

                const finalScore = clampScore(score);
                return { ...rec, suitabilityScore: finalScore, suitability: getSuitabilityLabel(finalScore), cropGroup: cropGroup(rec.crop) };
            };

            const dynamicRecs = fallbackRecs.map(scoreCrop).sort((a, b) => b.suitabilityScore - a.suitabilityScore);

            const selected = [];
            const groupCounts = {};
            const maxPerGroup = farmClass === 'small' ? 1 : 2;

            for (const rec of dynamicRecs) {
                const group = rec.cropGroup || 'other';
                if ((groupCounts[group] || 0) >= maxPerGroup) continue;
                selected.push(rec);
                groupCounts[group] = (groupCounts[group] || 0) + 1;
                if (selected.length >= 5) break;
            }

            if (selected.length < 5) {
                for (const rec of dynamicRecs) {
                    if (selected.some(item => cropKey(item.crop) === cropKey(rec.crop))) continue;
                    selected.push(rec);
                    if (selected.length >= 5) break;
                }
            }

                return res.json({ recommendations: selected.slice(0, 5), source: 'Rules-Based Logic Engine (Input-Adaptive Offline Mode)' });
            }
            
            const cleanReply = reply.replace(/```json/g, '').replace(/```/g, '').trim();
            const data = JSON.parse(cleanReply);
            if (Array.isArray(data.recommendations)) {
                data.recommendations = data.recommendations.map((item) => {
                    const score = Math.min(99, Math.max(10, Math.round(Number(item.suitabilityScore) || 0)));
                    return {
                        ...item,
                        suitabilityScore: score,
                        suitability: item.suitability || getSuitabilityLabel(score)
                    };
                }).sort((a, b) => b.suitabilityScore - a.suitabilityScore).slice(0, 5);
            }
            return res.json(data);
        }

        const cleanReply = geminiReply.replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(cleanReply);
        if (Array.isArray(data.recommendations)) {
            data.recommendations = data.recommendations.map((item) => {
                const score = Math.min(99, Math.max(10, Math.round(Number(item.suitabilityScore) || 0)));
                return {
                    ...item,
                    suitabilityScore: score,
                    suitability: item.suitability || getSuitabilityLabel(score)
                };
            }).sort((a, b) => b.suitabilityScore - a.suitabilityScore).slice(0, 5);
        }
        res.json(data);
    } catch (e) {
        console.error('Recommendation Error:', e);
        const fallback = buildCatalogRuleRecommendations(req.body || {}, MIN_RECOMMENDATION_RESULTS);
        if (fallback && Array.isArray(fallback.recommendations) && fallback.recommendations.length) {
            return res.status(200).json(buildRecommendationApiPayload({
                ...fallback,
                message: 'The live recommendation engine failed. Showing fallback recommendations instead.'
            }, true));
        }
        return res.status(500).json({
            success: false,
            message: 'Unable to generate recommendations right now.',
            error: 'Unable to generate recommendations right now.',
            recommendations: [],
            crops: []
        });
    }
}

app.post('/api/crop-recommendation', handleCropRecommendationLogic);

app.post('/api/recommendations', async (req, res) => {
    console.log('[RECOMMEND] /api/recommendations called, delegating to core logic');
    return handleCropRecommendationLogic(req, res);
});

app.get('/api/market-insights', async (req, res) => {
    try {
        const crop = req.query.crop || 'tomato';
        const requestedDate = req.query.date || 'today';
        const forceRefresh = String(req.query.refresh || '').toLowerCase() === '1' || String(req.query.refresh || '').toLowerCase() === 'true';
        const now = Date.now();
        const cacheDuration = 60 * 60 * 1000; // 1 hour

        // Refresh cache if needed
        if (
            forceRefresh ||
            !marketDataCache.data ||
            marketDataCache.requestedDate !== requestedDate ||
            (now - marketDataCache.lastUpdate) > cacheDuration
        ) {
            console.log('[MARKET] Refreshing live vegetable prices cache...');
            try {
                const scraped = await scrapeVegetablePrices(requestedDate);
                if (scraped?.rows?.length > 0) {
                    const previousRows = marketDataCache.data?.rows || [];
                    const rowsWithTrend = applyVegetableTrends(scraped.rows, previousRows);
                    marketDataCache.lastUpdate = now;
                    marketDataCache.requestedDate = requestedDate;
                    marketDataCache.data = {
                        ...scraped,
                        rows: rowsWithTrend
                    };
                }
            } catch (scrapeError) {
                console.warn('[MARKET] Live scrape failed, serving cached/fallback market data instead:', scrapeError.message);
            }
        }

        const fallbackRows = [
            { name: 'Onion Big', displayName: 'Onion Big', price: 21, retailPrice: '₹25 - 32', retailMin: 25, retailMax: 32, units: '1kg', imageUrl: '/resource/images/vegetables/onionbig-64.png', trend: 'stable', priceChange: 0 },
            { name: 'Onion Small', displayName: 'Onion Small', price: 40, retailPrice: '₹48 - 60', retailMin: 48, retailMax: 60, units: '1kg', imageUrl: '/resource/images/vegetables/onionsmall-64.png', trend: 'stable', priceChange: 0 },
            { name: 'Tomato', displayName: 'Tomato', price: 16, retailPrice: '₹19 - 24', retailMin: 19, retailMax: 24, units: '1kg', imageUrl: '/resource/images/vegetables/tomato-64.png', trend: 'stable', priceChange: 0 },
            { name: 'Green Chilli', displayName: 'Green Chilli', price: 40, retailPrice: '₹48 - 60', retailMin: 48, retailMax: 60, units: '1kg', imageUrl: '/resource/images/vegetables/greenchilli-64.png', trend: 'stable', priceChange: 0 },
            { name: 'Beetroot', displayName: 'Beetroot', price: 26, retailPrice: '₹31 - 39', retailMin: 31, retailMax: 39, units: '1kg', imageUrl: '/resource/images/vegetables/beetroot-64.png', trend: 'stable', priceChange: 0 }
        ];

        const cachedData = marketDataCache.requestedDate === requestedDate ? marketDataCache.data : null;
        const fallbackVariantRows = buildDateVariantRows(fallbackRows, requestedDate);
        const cachedRows = cachedData?.rows || fallbackVariantRows;
        const liveRows = cachedRows.length ? cachedRows : fallbackVariantRows;

        // Find current crop price
        const currentCrop = liveRows.find(p => p.name.toLowerCase() === crop.toLowerCase());
        const currentPrice = currentCrop ? currentCrop.price : 20 + Math.floor(Math.random() * 10);

        // Generate semi-realistic chart data ending at current price
        const chartData = Array.from({length: 30}, (_, i) => {
            if (i === 29) return currentPrice;
            const variance = Math.floor(Math.random() * 6) - 3; // -3 to +2
            return Math.max(10, currentPrice - (29 - i) * 0.5 + variance);
        });

        // Determine top gainer and loser from live prices
        const topGainerRow = pickTopMover(liveRows, 'up') || liveRows[0];
        const topLoserRow = pickTopMover(liveRows, 'down') || liveRows[liveRows.length - 1];
        const averagePrice = liveRows.length
            ? Math.round(liveRows.reduce((sum, row) => sum + Number(row.price || 0), 0) / liveRows.length)
            : 0;

        res.json({
            livePrices: liveRows.slice(0, 14).map(row => ({
                name: row.displayName || row.name,
                price: row.price,
                trend: row.trend || 'stable',
                imageUrl: row.imageUrl || '',
                priceChange: row.priceChange || 0
            })),
            rows: liveRows,
            chartData: chartData,
            sentiment: "Bullish",
            topGainer: {
                name: topGainerRow?.displayName || topGainerRow?.name || 'Onion Big',
                change: topGainerRow?.priceChange > 0 ? `+₹${topGainerRow.priceChange}` : `₹${topGainerRow?.price || 0}`
            },
            topLoser: {
                name: topLoserRow?.displayName || topLoserRow?.name || 'Potato',
                change: topLoserRow?.priceChange < 0 ? `-₹${Math.abs(topLoserRow.priceChange)}` : `₹${topLoserRow?.price || 0}`
            },
            harvestValue: averagePrice * Math.max(liveRows.length, 1) * 50,
            source: {
                url: cachedData?.sourceUrl || 'https://www.vegetablemarketprice.com/market/tamilnadu/today',
                dateLabel: cachedData?.sourceDateLabel || formatDateLabel(requestedDate),
                fetchedAt: cachedData?.fetchedAt || new Date().toISOString(),
                requestedDate
            },
            isFallback: !cachedData,
            requestedDate,
            selectedDateLabel: cachedData?.sourceDateLabel || formatDateLabel(requestedDate),
            prediction: cachedData
                ? `Tamil Nadu market snapshot loaded from vegetablemarketprice.com for ${cachedData?.sourceDateLabel || formatDateLabel(requestedDate)}.`
                : `Tamil Nadu fallback market snapshot loaded for ${formatDateLabel(requestedDate)}.`
        });
    } catch (e) {
        console.error('Market Insights Endpoint Error:', e);
        const requestedDate = req.query.date || 'today';
        const fallbackRows = buildDateVariantRows([
            { name: 'Onion Big', displayName: 'Onion Big', price: 21, retailPrice: '₹25 - 32', retailMin: 25, retailMax: 32, units: '1kg', imageUrl: '/resource/images/vegetables/onionbig-64.png', trend: 'stable', priceChange: 0 },
            { name: 'Onion Small', displayName: 'Onion Small', price: 40, retailPrice: '₹48 - 60', retailMin: 48, retailMax: 60, units: '1kg', imageUrl: '/resource/images/vegetables/onionsmall-64.png', trend: 'stable', priceChange: 0 },
            { name: 'Tomato', displayName: 'Tomato', price: 16, retailPrice: '₹19 - 24', retailMin: 19, retailMax: 24, units: '1kg', imageUrl: '/resource/images/vegetables/tomato-64.png', trend: 'stable', priceChange: 0 },
            { name: 'Green Chilli', displayName: 'Green Chilli', price: 40, retailPrice: '₹48 - 60', retailMin: 48, retailMax: 60, units: '1kg', imageUrl: '/resource/images/vegetables/greenchilli-64.png', trend: 'stable', priceChange: 0 },
            { name: 'Beetroot', displayName: 'Beetroot', price: 26, retailPrice: '₹31 - 39', retailMin: 31, retailMax: 39, units: '1kg', imageUrl: '/resource/images/vegetables/beetroot-64.png', trend: 'stable', priceChange: 0 }
        ], requestedDate);
        res.json({
            livePrices: fallbackRows.map(row => ({
                name: row.displayName || row.name,
                price: row.price,
                trend: row.trend || 'stable',
                imageUrl: row.imageUrl || '',
                priceChange: row.priceChange || 0
            })),
            rows: fallbackRows,
            chartData: fallbackRows.map((row) => row.price),
            sentiment: 'Neutral',
            topGainer: {
                name: fallbackRows[0]?.displayName || fallbackRows[0]?.name || 'Onion Big',
                change: `₹${fallbackRows[0]?.price || 0}`
            },
            topLoser: {
                name: fallbackRows[fallbackRows.length - 1]?.displayName || fallbackRows[fallbackRows.length - 1]?.name || 'Beetroot',
                change: `₹${fallbackRows[fallbackRows.length - 1]?.price || 0}`
            },
            harvestValue: fallbackRows.reduce((sum, row) => sum + Number(row.price || 0), 0) * 10,
            source: {
                url: 'https://www.vegetablemarketprice.com/market/tamilnadu/today',
                dateLabel: formatDateLabel(requestedDate),
                fetchedAt: new Date().toISOString(),
                requestedDate
            },
            isFallback: true,
            requestedDate,
            selectedDateLabel: formatDateLabel(requestedDate),
            prediction: `Tamil Nadu fallback market snapshot loaded for ${formatDateLabel(requestedDate)}.`
        });
    }
});

app.get('/api/analytics', (req, res) => {
    res.json({
        activeCrops: 0,
        healthScore: 92,
        monthlyPerformance: [
            { month: "Jan", value: 65 },
            { month: "Feb", value: 72 },
            { month: "Mar", value: 81 },
            { month: "Apr", value: 85 },
            { month: "May", value: 89 },
            { month: "Jun", value: 92 }
        ]
    });
});

app.get('/api/disease-image-search', (req, res) => {
    const crop = req.query.crop;
    const name = req.query.name || req.query.disease;
    if (!name) return res.status(400).json({ error: 'Disease name is required' });
    
    const crp = (crop || '').toLowerCase();
    
    const library = {
        'rice blast': '/images/diseases/blast_disease.png',
        'rice sheath rot': '/images/diseases/sheath_rot.png',
        'tomato early blight': '/images/diseases/early_blight.png',
        'potato early blight': '/images/diseases/early_blight.png',
        'tomato fusarium wilt': '/images/diseases/fusarium_wilt.png',
        'chickpea fusarium wilt': '/images/diseases/chickpea_fusarium_wilt.png',
        'chickpea ascochyta blight': '/images/diseases/chickpea_ascochyta_blight.png',
        'chickpea collar rot': '/images/diseases/chickpea_collar_rot.png',
        'groundnut collar rot': '/images/diseases/chickpea_collar_rot.png',
        'cotton bacterial blight': '/images/diseases/bacterial_blight.png',
        'cotton root rot': '/images/diseases/cotton_root_rot.png',
        'wheat rust': '/images/diseases/wheat_rust.png',
        'wheat loose smut': '/images/diseases/loose_smut.png',
        'maize smut': '/images/diseases/maize_smut.png',
        'maize leaf blight': '/images/diseases/maize_leaf_blight.png',
        'maize stalk rot': '/images/diseases/maize_stalk_rot.png',
        'sunflower alternaria leaf spot': '/images/diseases/sunflower_alternaria_leaf_spot.png',
        'sunflower stem rot': '/images/diseases/sunflower_stem_rot.png',
        'sugarcane red rot': '/images/diseases/sugarcane_red_rot.png',
        'sugarcane smut': '/images/diseases/sugarcane_smut.png',
        'rice udbatta': '/images/diseases/udbatta_disease.png',
        'soybean rust': '/images/diseases/soybean_rust.png',
        'groundnut leaf spot': '/images/diseases/leaf_spot.png',
        'chili leaf spot': '/images/diseases/leaf_spot.png',
        'onion leaf spot': '/images/diseases/leaf_spot.png',
        'soybean leaf spot': '/images/diseases/leaf_spot.png',
        'chili anthracnose': '/images/diseases/anthracnose.png',
        'onion purple blotch': '/images/diseases/purple_blotch.png',
        'black gram yellow mosaic virus': '/images/diseases/gram_yellow_mosaic_virus.png',
        'black gram powdery mildew': '/images/diseases/gram_powdery_mildew.png',
        'green gram yellow mosaic virus': '/images/diseases/gram_yellow_mosaic_virus.png',
        'green gram cercospora leaf spot': '/images/diseases/gram_cercospora_leaf_spot.png'
    };

    const key = `${crp} ${name}`.trim();
    let url = library[key];
    
    if (!url) {
        // Fallback to name search
        const found = Object.keys(library).find(k => k.includes(name.toLowerCase()));
        if (found) url = library[found];
    }

    res.json({ url: url || '/images/diseases/leaf_spot.png', source: 'Internal Database' });
});

app.get('/api/disease-care', (req, res) => {
    const { crop, lang = 'en' } = req.query;
    const isTa = lang === 'ta';

    const diseaseImageLibrary = {
        'rice blast': '/images/diseases/blast_disease.png',
        'rice sheath rot': '/images/diseases/sheath_rot.png',
        'rice udbatta disease': '/images/diseases/udbatta_disease.png',
        'wheat rust': '/images/diseases/wheat_rust.png',
        'wheat loose smut': '/images/diseases/loose_smut.png',
        'tomato early blight': '/images/diseases/early_blight.png',
        'tomato fusarium wilt': '/images/diseases/fusarium_wilt.png',
        'potato early blight': '/images/diseases/early_blight.png',
        'potato late blight': '/images/diseases/leaf_spot.png',
        'maize leaf blight': '/images/diseases/maize_leaf_blight.png',
        'maize smut': '/images/diseases/maize_smut.png',
        'sugarcane red rot': '/images/diseases/sugarcane_red_rot.png',
        'sugarcane smut': '/images/diseases/sugarcane_smut.png',
        'cotton bacterial blight': '/images/diseases/bacterial_blight.png',
        'cotton root rot': '/images/diseases/cotton_root_rot.png',
        'soybean rust': '/images/diseases/soybean_rust.png',
        'groundnut leaf spot': '/images/diseases/leaf_spot.png',
        'groundnut collar rot': '/images/diseases/groundnut_collar_rot.png',
        'chili leaf spot': '/images/diseases/chilli_leaf_spot.png',
        'chili anthracnose': '/images/diseases/anthracnose.png',
        'onion leaf spot': '/images/diseases/onion_leaf_spot.png',
        'onion purple blotch': '/images/diseases/purple_blotch.png',
        'chickpea fusarium wilt': '/images/diseases/chickpea_fusarium_wilt.png',
        'chickpea ascochyta blight': '/images/diseases/chickpea_ascochyta_blight.png',
        'chickpea collar rot': '/images/diseases/chickpea_collar_rot.png',
        'sunflower alternaria leaf spot': '/images/diseases/sunflower_alternaria_leaf_spot.png',
        'sunflower stem rot': '/images/diseases/sunflower_stem_rot.png',
        'black gram yellow mosaic virus': '/images/diseases/gram_yellow_mosaic_virus.png',
        'black gram powdery mildew': '/images/diseases/gram_powdery_mildew.png',
        'green gram yellow mosaic virus': '/images/diseases/gram_yellow_mosaic_virus.png',
        'green gram cercospora leaf spot': '/images/diseases/gram_cercospora_leaf_spot.png'
    };

    const cropAliases = {
        'Rice/Paddy': 'rice',
        'Wheat': 'wheat',
        'Tomato': 'tomato',
        'Potato': 'potato',
        'Maize/Corn': 'maize',
        'Sugarcane': 'sugarcane',
        'Cotton': 'cotton',
        'Soybean': 'soybean',
        'Groundnut': 'groundnut',
        'Chili': 'chili',
        'Onion': 'onion',
        'Chickpea': 'chickpea',
        'Sunflower': 'sunflower',
        'Black Gram': 'black gram',
        'Green Gram': 'green gram'
    };

    const diseaseAliases = {
        'blast': 'blast',
        'குமிழி நோய்': 'blast',
        'sheath rot': 'sheath rot',
        'உறையழுகல் நோய்': 'sheath rot',
        'udbatta disease': 'udbatta disease',
        'உத்பாட்டா நோய்': 'udbatta disease',
        'rust': 'rust',
        'துரு நோய்': 'rust',
        'wheat rust': 'rust',
        'loose smut': 'loose smut',
        'smut': 'loose smut',
        'கரிப்பூட்டை நோய்': 'loose smut',
        'early blight': 'early blight',
        'ஆரம்பகால கருகல்': 'early blight',
        'ஆரம்ப கால கருகல்': 'early blight',
        'fusarium wilt': 'fusarium wilt',
        'பியூசேரியம் வாடல்': 'fusarium wilt',
        'late blight': 'late blight',
        'லேட் பிளைட்': 'late blight',
        'maize leaf blight': 'maize leaf blight',
        'சோள இலைக்கருகல்': 'maize leaf blight',
        'maize smut': 'maize smut',
        'சோளக் கரிப்பூட்டை': 'maize smut',
        'red rot': 'red rot',
        'செவ்வழுகல் நோய்': 'red rot',
        'sugarcane smut': 'sugarcane smut',
        'கரும்பு கரிப்பூட்டை': 'sugarcane smut',
        'bacterial blight': 'bacterial blight',
        'பாக்டீரியா கருகல்': 'bacterial blight',
        'root rot': 'root rot',
        'வேர் அழுகல் நோய்': 'root rot',
        'leaf spot': 'leaf spot',
        'இலைப்புள்ளி நோய்': 'leaf spot',
        'anthracnose': 'anthracnose',
        'ஆந்த்ராக்னோஸ்': 'anthracnose',
        'purple blotch': 'purple blotch',
        'ஊதா கறை நோய்': 'purple blotch',
        'ascochyta blight': 'ascochyta blight',
        'collar rot': 'collar rot',
        'alternaria leaf spot': 'alternaria leaf spot',
        'stem rot': 'stem rot',
        'yellow mosaic virus': 'yellow mosaic virus',
        'powdery mildew': 'powdery mildew',
        'cercospora leaf spot': 'cercospora leaf spot'
    };

    function resolveDiseaseImage(cropId, diseaseName) {
        const cropKey = cropAliases[cropId] || String(cropId || '').toLowerCase();
        const rawName = String(diseaseName || '').trim();
        const englishInParens = rawName.match(/\(([^)]+)\)/);
        const lowerName = rawName.toLowerCase();
        const nameCandidates = [
            englishInParens ? englishInParens[1].trim().toLowerCase() : '',
            lowerName
        ].filter(Boolean);

        let canonicalDisease = '';
        for (const candidate of nameCandidates) {
            const found = Object.entries(diseaseAliases).find(([key]) => candidate.includes(key.toLowerCase()));
            if (found) {
                canonicalDisease = found[1];
                break;
            }
        }

        const baseDiseaseKey = canonicalDisease || lowerName;
        const combinedKey = baseDiseaseKey.startsWith(`${cropKey} `)
            ? baseDiseaseKey
            : `${cropKey} ${baseDiseaseKey}`.trim();
        return (
            diseaseImageLibrary[combinedKey] ||
            diseaseImageLibrary[`${cropKey} ${lowerName}`] ||
            diseaseImageLibrary[combinedKey.replace(/\s+/g, ' ')] ||
            null
        );
    }
    
    const cropData = {
        'Rice/Paddy': {
            prevention: [
                isTa ? 'சான்றிதழ் பெற்ற நோய் தாக்காத விதைகளைப் பயன்படுத்தவும்.' : 'Use certified disease-free seeds.',
                isTa ? 'வயலை சுத்தமாக வைத்திருந்து முந்தைய பயிர் எச்சங்களை அகற்றவும்.' : 'Keep the field clean and remove previous crop residues.',
                isTa ? 'தழைச்சத்தை (Nitrogen) பிரித்து இடவும்.' : 'Apply nitrogenous fertilizers in split doses.',
                isTa ? 'வயலில் சீரான அளவில் நீரை நிறுத்தவும்.' : 'Maintain a thin film of water in the field.'
            ],
            treatment: [
                isTa ? 'குமிழி நோய்க்கு (Blast) ட்ரைசைக்ளோசோல் தெளிக்கவும்.' : 'Spray Tricyclazole for Blast disease.',
                isTa ? 'சரியான உர மேலாண்மை மூலம் எதிர்ப்புத் திறனை அதிகரிக்கவும்.' : 'Increase resistance through balanced fertilizer management.',
                isTa ? 'உறையழுகல் நோய்க்கு (Sheath rot) கார்பெண்டாசிம் பயன்படுத்தவும்.' : 'Apply Carbendazim for Sheath rot.'
            ],
            careTips: [
                isTa ? 'நடவு செய்த முதல் வாரத்தில் 2-3 செ.மீ நீரை பராமரிக்கவும்.' : 'Maintain 2-3 cm water level during the first week after transplanting.',
                isTa ? 'வாரம் ஒருமுறை பயிர் வளர்ச்சியை கண்காணிக்கவும்.' : 'Monitor crop growth once a week.',
                isTa ? 'பயிருக்கு கயிறு தேய்த்து இலைத் தேய்ப்பு பூச்சிகளைக் கட்டுப்படுத்தலாம்.' : 'Use a rope to disturb and control leaf folders.'
            ],
            harvestingTips: [
                isTa ? 'தானியங்கள் 80-85% முதிர்ந்தவுடன் அறுவடை செய்யவும்.' : 'Harvest when 80-85% of the grains are mature.',
                isTa ? 'காலை நேரங்களில் அறுவடை செய்வதைத் தவிர்க்கவும்.' : 'Avoid harvesting during morning hours with dew.'
            ],
            sustainablePractices: [
                isTa ? 'பசுந்தாள் உரங்களைப் பயன்படுத்தவும்.' : 'Use green manure crops.',
                isTa ? 'வேப்பம் புண்ணாக்கை உரமாக இடுங்கள்.' : 'Apply neem cake as fertilizer.'
            ],
            irrigationStrategies: [
                isTa ? 'மாற்று ஈர மற்றும் உலர் நீர்ப்பாசன முறையை (AWD) பின்பற்றவும்.' : 'Follow Alternate Wetting and Drying (AWD) method.',
                isTa ? 'நீரை வீணாக்காமல் குழாய்கள் மூலம் பாய்ச்சவும்.' : 'Use pipes to carry water without wastage.'
            ],
            agriculturalInputs: [
                isTa ? 'யூரியா' : 'Urea',
                isTa ? 'டி.ஏ.பி' : 'DAP',
                isTa ? 'பொட்டாஷ்' : 'Potash',
                isTa ? 'நுண்ணூட்டச்சத்து கலவை' : 'Micronutrient Mixture'
            ],
            diseases: [
                { name: isTa ? 'குமிழி நோய் (Blast)' : 'Rice Blast', symptoms: isTa ? 'இலைகளில் கண் வடிவப் புள்ளிகள் தோன்றும்.' : 'Eye-shaped spots appear on leaves.' },
                { name: isTa ? 'உறையழுகல் நோய் (Sheath Rot)' : 'Sheath Rot', symptoms: isTa ? 'மேல் இலை உரைகளில் பழுப்பு நிறப் புள்ளிகள்.' : 'Brownish spots on upper leaf sheaths.' },
                { name: isTa ? 'உத்பாட்டா நோய்' : 'Udbatta Disease', symptoms: isTa ? 'கதிர்கள் ஊசி போன்ற வடிவத்தில் மாறும்.' : 'Panicles transformed into needle-like structures.' }
            ]
        },
        'Wheat': {
            prevention: [
                isTa ? 'முன்கூட்டியே விதைப்பதைத் தவிர்க்கவும்.' : 'Avoid early sowing to prevent rust.',
                isTa ? 'நோய் எதிர்ப்புத் திறன் கொண்ட ரகங்களைத் தேர்ந்தெடுக்கவும்.' : 'Select rust-resistant varieties.',
                isTa ? 'விதை நேர்த்தி செய்ய கார்பாக்சின் பயன்படுத்தவும்.' : 'Use Carboxin for seed treatment.'
            ],
            treatment: [
                isTa ? 'துரு நோய்க்கு (Rust) புரோபிகோனசோல் தெளிக்கவும்.' : 'Spray Propiconazole for Rust disease.',
                isTa ? 'கரிப்பூட்டை நோய்க்கு (Smut) முறையான விதை நேர்த்தியே தீர்வு.' : 'Proper seed treatment is the key for Smut.'
            ],
            careTips: [
                isTa ? 'முக்கியமான வளர்ச்சி நிலைகளில் நீர்ப்பாசனம் செய்யவும்.' : 'Irrigate during critical growth stages (e.g. CRI).',
                isTa ? 'களைகளைக் கட்டுப்படுத்துவது மகசூலுக்கு முக்கியம்.' : 'Weed management is crucial for yield.'
            ],
            harvestingTips: [
                isTa ? 'தானியங்கள் கடினமான பிறகு அறுவடை செய்யவும்.' : 'Harvest when grains are hard and dry.',
                isTa ? 'அறுவடைக்கு பின் மட்கும் இயந்திரங்களைப் பயன்படுத்தவும்.' : 'Use threshing machines after harvest.'
            ],
            sustainablePractices: [
                isTa ? 'பயிர் சுழற்சி முறையைப் பின்பற்றவும்.' : 'Follow crop rotation practices.',
                isTa ? 'மண் வளத்தைப் பாதுகாக்க தழை உரமிடுதல்.' : 'Mulching to preserve soil moisture.'
            ],
            irrigationStrategies: [
                isTa ? 'தெளிப்பு நீர்ப்பாசனம் சிறந்தது.' : 'Sprinkler irrigation is effective.',
                isTa ? 'வேர் பகுதிகளில் ஈரம் இருப்பதை உறுதி செய்யவும்.' : 'Ensure moisture at the root zone.'
            ],
            agriculturalInputs: [
                isTa ? 'N-P-K கலவை' : 'N-P-K Fertilizer',
                isTa ? 'துத்தநாக சல்பேட்' : 'Zinc Sulphate',
                isTa ? 'ஜிப்சம்' : 'Gypsum'
            ],
            diseases: [
                { name: isTa ? 'கோதுமை துரு நோய்' : 'Wheat Rust', symptoms: isTa ? 'இலைகளில் ஆரஞ்சு அல்லது கருப்பு பொட்டுக்கள்.' : 'Orange or black pustules on leaves.' },
                { name: isTa ? 'கரிப்பூட்டை நோய்' : 'Loose Smut', symptoms: isTa ? 'கதிர்களில் கருப்பு நிறத் தூள்கள் தோன்றும்.' : 'Black powdery mass on panicles.' }
            ]
        },
        'Tomato': {
            prevention: [
                isTa ? 'வயலில் தண்ணீர் தேங்குவதைத் தவிர்க்கவும்.' : 'Avoid waterlogging in the field.',
                isTa ? 'நடும் முன் வேர் முனைகளில் பூஞ்சான் கொல்லி நேர்த்தி.' : 'Root dip treatment before transplanting.'
            ],
            treatment: [
                isTa ? 'வாடல் நோய்க்கு காப்பர் ஆக்ஸிகுளோரைடு பயன்படுத்தவும்.' : 'Apply Copper Oxychloride for wilt diseases.',
                isTa ? 'இலைத் தேமல் நோய்க்கு வேம்பு எண்ணெய் தெளிக்கவும்.' : 'Spray Neem oil for leaf curl virus vector control.'
            ],
            careTips: [
                 isTa ? 'செடிகளுக்கு முட்டுக்கொடுத்து நேராக வளர்க்கவும்.' : 'Provide staking support for vertical growth.',
                 isTa ? 'அடிப்பகுதி இலைகளை அகற்றி காற்றோட்டத்தை அதிகரிக்கவும்.' : 'Prune lower leaves to increase aeration.'
            ],
            harvestingTips: [
                isTa ? 'தூரம் கொண்டு செல்ல வேண்டிய பழங்களை முதிர்ந்த பச்சை நிலையில் பறிக்கவும்.' : 'Harvest at mature green stage for long-distance transport.',
                isTa ? 'உள்ளூர் சந்தைக்கு எனில் முழு சிவந்த நிலையில் பறிக்கவும்.' : 'Harvest at fully ripe stage for local markets.'
            ],
            sustainablePractices: [
                 isTa ? 'பூச்சி விரட்ட சாமந்தி செடிகளை ஊடுபயிராக நடவும்.' : 'Intercrop with Marigold to repel pests.',
                 isTa ? 'கரிமக் கம்போஸ்ட் அதிகளவில் பயன்படுத்தவும்.' : 'Use organic compost generously.'
            ],
            irrigationStrategies: [
                 isTa ? 'சொட்டு நீர்ப்பாசனம் (Drip) மூலம் நோய் பரவலைக் குறைக்கலாம்.' : 'Drip irrigation reduces disease spread.',
                 isTa ? 'மாலையி்ல் நீர்ப்பாய்ச்சுவதைத் தவிர்க்கவும்.' : 'Avoid late evening irrigation.'
            ],
            agriculturalInputs: [
                isTa ? 'வெர்மிகம்போஸ்ட்' : 'Vermicompost',
                isTa ? 'வேப்பம் புண்ணாக்கு' : 'Neem Cake',
                isTa ? 'கால்சியம் நைட்ரேட்' : 'Calcium Nitrate'
            ],
            diseases: [
                { name: isTa ? 'ஆரம்பகால கருகல்' : 'Early Blight', symptoms: isTa ? 'கீழ் இலைகளில் பழுப்பு நிற வளையங்கள்.' : 'Concentric brown rings on lower leaves.' },
                { name: isTa ? 'பியூசேரியம் வாடல்' : 'Fusarium Wilt', symptoms: isTa ? 'செடி முழுவதும் வாடி காய்ந்துவிடும்.' : 'Rapid yellowing and wilting of the whole plant.' }
            ]
        },
        'Maize/Corn': {
            prevention: [
                isTa ? 'விதைகளைத் தேர்ந்தெடுத்து விதை நேர்த்தி செய்யவும்.' : 'Treat seeds with fungicides before sowing.',
                isTa ? 'முறையான பயிர் சுழற்சி முறையைப் பின்பற்றவும்.' : 'Implement proper crop rotation.',
                isTa ? 'வயலைச் சுற்றியுள்ள களைகளை அகற்றவும்.' : 'Remove weeds around the field boundaries.'
            ],
            treatment: [
                isTa ? 'இலைக்கருகல் நோய்க்கு மேன்கோசெப் தெளிக்கவும்.' : 'Spray Mancozeb for leaf blight.',
                isTa ? 'தண்டு அழுகல் நோய்க்கு முறையான வடிகால் வசதி தேவை.' : 'Ensure proper drainage for stalk rot management.'
            ],
            careTips: [
                isTa ? 'பூக்கும் பருவத்தில் நீர் பற்றாக்குறை இல்லாமல் பார்த்துக்கொள்ளவும்.' : 'Avoid water stress during the flowering stage.',
                isTa ? 'மண்ணில் போதிய அளவு தழைச்சத்து இருப்பதை உறுதி செய்யவும்.' : 'Ensure adequate nitrogen levels in the soil.'
            ],
            harvestingTips: [
                isTa ? 'கதிர்கள் நன்கு காய்ந்த பிறகு அறுவடை செய்யவும்.' : 'Harvest when the husks are dry and grains are hard.',
                isTa ? 'தானியங்களில் ஈரப்பதம் 12-14% இருக்குமாறு காயவைக்கவும்.' : 'Dry the grains to 12-14% moisture content.'
            ],
            sustainablePractices: [
                isTa ? 'இயற்கை உரங்களை அதிகளவில் பயன்படுத்தவும்.' : 'Use organic fertilizers extensively.',
                isTa ? 'உயிரி பூச்சிக்கொல்லிகளை முன்னுரிமை அளிக்கவும்.' : 'Prioritize the use of bio-pesticides.'
            ],
            irrigationStrategies: [
                isTa ? 'வயலில் தண்ணீர் தேங்குவதைத் தவிர்க்கவும்.' : 'Prevent waterlogging in the maize field.',
                isTa ? 'முக்கிய வளர்ச்சி நிலைகளில் தவறாமல் நீர்ப்பாசனம் செய்யவும்.' : 'Irrigate regularly during critical growth stages.'
            ],
            agriculturalInputs: [
                isTa ? 'யூரியா' : 'Urea',
                isTa ? 'சூப்பர் பாஸ்பேட்' : 'Single Super Phosphate (SSP)',
                isTa ? 'துத்தநாக சல்பேட்' : 'Zinc Sulphate'
            ],
            diseases: [
                { name: isTa ? 'சோள இலைக்கருகல்' : 'Maize Leaf Blight', symptoms: isTa ? 'இலைகளில் நீண்ட பழுப்பு நிறப் புள்ளிகள்.' : 'Long, elliptical, grayish-green or tan lesions on leaves.' },
                { name: isTa ? 'சோளக் கரிப்பூட்டை' : 'Maize Smut', symptoms: isTa ? 'கதிர்களில் வெள்ளை நிறப் பைகள் தோன்றி கருப்பாக மாறும்.' : 'White galls on ears that turn into black powdery mass.' }
            ]
        },
        'Sugarcane': {
             prevention: [
                isTa ? 'நோய் தாக்காத கரணைகளைத் தேர்ந்தெடுக்கவும்.' : 'Select disease-free setts for planting.',
                isTa ? 'கரணைகளை நடும் முன் சுடு நீர் நேர்த்தி செய்யவும்.' : 'Treat setts with hot water before planting.'
            ],
            treatment: [
                isTa ? 'செவ்வழுகல் நோயைக் கட்டுப்படுத்த கார்பெண்டாசிம் பயன்படுத்தவும்.' : 'Use Carbendazim for red rot management.',
                isTa ? 'பாதிக்கப்பட்ட தூர்களை உடனே அகற்றி எரிக்கவும்.' : 'Remove and burn infected clumps immediately.'
            ],
            careTips: [
                 isTa ? 'பயிர்களுக்கு மண் அணைத்தல் (Earthing up) வேலையைச் செய்யவும்.' : 'Perform timely earthing up operations.',
                 isTa ? 'சோகை உரித்தல் மூலம் பூச்சித் தாக்குதலைக் குறைக்கலாம்.' : 'Detach old leaves (detrashing) to reduce pest hiding spots.'
            ],
            harvestingTips: [
                isTa ? 'சர்க்கரை அளவு உச்சத்தில் இருக்கும்போது அறுவடை செய்யவும்.' : 'Harvest when sugar content (Brix) is at its peak.',
                isTa ? 'அறுவடை செய்தவுடன் ஆலைக்கு அனுப்பவும்.' : 'Transport to the factory immediately after harvest.'
            ],
            sustainablePractices: [
                 isTa ? 'தோகைகளை எரிக்காமல் மண்ணில் மட்கச் செய்யவும்.' : 'Trash mulching instead of burning crop residues.',
                 isTa ? 'ஊடுபயிராக பயறு வகைகளை விளைவிக்கவும்.' : 'Grow legumes as an intercrop.'
            ],
            irrigationStrategies: [
                 isTa ? 'கரும்புக்கு சொட்டு நீர்ப்பாசனம் மேலானது.' : 'Drip irrigation is highly efficient for sugarcane.',
                 isTa ? 'வறட்சி காலங்களில் நீண்ட இடைவெளியைத் தவிர்க்கவும்.' : 'Avoid long irrigation intervals during summer.'
            ],
            agriculturalInputs: [
                isTa ? 'தொழு உரம்' : 'Farm Yard Manure (FYM)',
                isTa ? 'திரவ பயோ உரங்கள்' : 'Liquid Bio-fertilizers',
                isTa ? 'நுண்ணூட்டச்சத்து கலவை' : 'Micronutrient Mixture'
            ],
            diseases: [
                { name: isTa ? 'செவ்வழுகல் நோய்' : 'Red Rot', symptoms: isTa ? 'தண்டின் உள்ளே சிவப்பு நிறக் கோடுகள்.' : 'Reddish lesions and acidic smell inside the stalk.' },
                { name: isTa ? 'கரும்பு கரிப்பூட்டை' : 'Sugarcane Smut', symptoms: isTa ? 'உச்சிக் குருத்தில் இருந்து கசையடித்தது போன்ற கருப்புத் தண்டு.' : 'Whip-like black structure from the shoot apex.' }
            ]
        },
        'Cotton': {
            prevention: [
                isTa ? 'சான்றிதழ் பெற்ற விதைகளை மட்டும் பயன்படுத்தவும்.' : 'Use only certified and treated seeds.',
                isTa ? 'பருத்திக்கு பின் அதே இனம் அல்லாத பயிரைப் பயிரிடவும்.' : 'Follow crop rotation with non-host crops.'
            ],
            treatment: [
                isTa ? 'பாக்டீரியல் வாடல் நோய்க்கு ஸ்டரெப்டோமைசின் பயன்படுத்தவும்.' : 'Use Streptokinase/Streptomycin for bacterial blight.',
                isTa ? 'வேர் அழுகல் நோய்க்கு டிரைக்கோடெர்மா விரிடி பயன்படுத்தவும்.' : 'Apply Trichoderma viride for root rot control.'
            ],
            careTips: [
                 isTa ? 'முனைக் கிள்ளுதல் மூலம் பக்கக் கிளைகளை அதிகரிக்கலாம்.' : 'Perform topping to encourage lateral branching.',
                 isTa ? 'களைகளைக் கட்டுப்படுத்துவது பருத்திக்கு மிகவும் அவசியம்.' : 'Manual weeding is essential for healthy cotton growth.'
            ],
            harvestingTips: [
                isTa ? 'வெடித்த பருத்திக் காய்களை காலை நேரத்தில் பறிக்கவும்.' : 'Pick matured bolls during early morning to avoid trash.',
                isTa ? 'தூய்மையான பருத்தியை மட்டும் தனியாகச் சேகரிக்கவும்.' : 'Store clean cotton separately from stained one.'
            ],
            sustainablePractices: [
                 isTa ? 'பூச்சிகளைக் கவர இனக்கவர்ச்சிப் பொறிகளைப் பயன்படுத்தவும்.' : 'Install pheromone traps for pest monitoring.',
                 isTa ? 'வேப்பம் எண்ணெயைத் தெளிக்கவும்.' : 'Use neem-based sprays as repellent.'
            ],
            irrigationStrategies: [
                 isTa ? 'பூக்கும் மற்றும் காய் பிடிக்கும் பருவத்தில் அதிக நீர் தேவை.' : 'High water demand during flowering and boll formation.',
                 isTa ? 'வாய்க்கால் பாசனத்தை விட சொட்டு நீர் பாசனம் சிறந்தது.' : 'Drip irrigation is preferred over furrow irrigation.'
            ],
            agriculturalInputs: [
                isTa ? 'நுண்ணூட்டச்சத்து மாத்திரைகள்' : 'Micronutrient Pellets',
                isTa ? 'இயற்கை பூச்சி விரட்டிகள்' : 'Bio-pesticides',
                isTa ? 'திரவ உரம்' : 'Liquid Fertilizer'
            ],
            diseases: [
                { name: isTa ? 'பாக்டீரியா கருகல்' : 'Bacterial Blight', symptoms: isTa ? 'இலைகளில் முக்கோண வடிவ பழுப்புப் புள்ளிகள்.' : 'Angular water-soaked lesions on leaves and bolls.' },
                { name: isTa ? 'வேர் அழுகல் நோய்' : 'Root Rot', symptoms: isTa ? 'செடிகள் திடீரென வாடி காய்ந்துவிடும்.' : 'Sudden wilting and death of plants, roots turn dark.' }
            ]
        },
        'Potato': {
            prevention: [
                isTa ? 'நோய் தாக்காத விதைக் கிழங்குகளைப் பயன்படுத்தவும்.' : 'Use certified disease-free seed tubers.',
                isTa ? 'கிழங்குகளை நடும் முன் பூஞ்சான் கொல்லி நேர்த்தி.' : 'Treat tubers with fungicides before planting.'
            ],
            treatment: [
                isTa ? 'பிந்தைய கருகல் நோய்க்கு மெட்டாலாக்ஸில் தெளிக்கவும்.' : 'Spray Metalaxyl for late blight control.',
                isTa ? 'முறையான பயிர் இடைவெளி மூலம் நோய் பரவலைத் தவிர்க்கவும்.' : 'Maintain proper spacing to reduce humidity around plants.'
            ],
            careTips: [
                 isTa ? 'முறையாக மண் அணைத்தல் (Earthing up) செய்ய வேண்டும்.' : 'Timely earthing up is crucial for tuber development.',
                 isTa ? 'செப்புகளுக்கு நைட்ரஜன் உரத்தை பிரித்து இடவும்.' : 'Apply nitrogen in split doses.'
            ],
            harvestingTips: [
                isTa ? 'அறுவடைக்கு முன் செடிகளின் மேல் பாகத்தை அகற்றி (Dehaulming) 10 நாட்கள் கழித்து அறுவடை செய்யவும்.' : 'Perform dehaulming 10-14 days before harvesting.',
                isTa ? 'கிழங்குகளில் சிராய்ப்பு ஏற்படாமல் கவனமாகத் தோண்டவும்.' : 'Avoid mechanical damage to tubers during digging.'
            ],
            sustainablePractices: [
                 isTa ? 'உயிரி பூஞ்சான் கொல்லிகளைப் பயன்படுத்தவும்.' : 'Incorporate bio-fungicides like Trichoderma.',
                 isTa ? 'நிழலான இடங்களில் கிழங்குகளைச் சேமிக்கவும்.' : 'Store tubers in cool, dark ventilated places.'
            ],
            irrigationStrategies: [
                 isTa ? 'கிழங்கு உருவாகும் போது சமமான ஈரம் தேவை.' : 'Maintain uniform moisture during tuber initiation.',
                 isTa ? 'மாலையி்ல் நீர் பாய்ச்சுவதைத் தவிர்க்கவும்.' : 'Avoid late evening irrigation to prevent blight.'
            ],
            agriculturalInputs: [
                isTa ? 'MOP (பொட்டாஷ்)' : 'Muriate of Potash (MOP)',
                isTa ? 'வெர்மிகம்போஸ்ட்' : 'Vermicompost',
                isTa ? 'துத்தநாக சல்பேட்' : 'Zinc Sulphate'
            ],
            diseases: [
                { name: isTa ? 'ஆரம்ப கால கருகல்' : 'Early Blight', symptoms: isTa ? 'இலைகளில் பழுப்பு நிற வளையங்கள்.' : 'Target-like brown spots on lower leaves.' },
                { name: isTa ? 'லேட் பிளைட் (பிந்தைய கருகல்)' : 'Late Blight', symptoms: isTa ? 'இலைகளின் அடியில் வெள்ளை நிறப் பூஞ்சை வளர்ச்சி.' : 'Water-soaked spots with white fungal growth underneath.' }
            ]
        },
        'Groundnut': {
            prevention: [
                isTa ? 'சான்றிதழ் பெற்ற விதைகளை மட்டும் பயன்படுத்தவும்.' : 'Use only certified and treated seeds.',
                isTa ? 'பயிர் சுழற்சி முறையைப் பின்பற்றவும்.' : 'Follow crop rotation to reduce soil-borne diseases.',
                isTa ? 'முறையான வடிகால் வசதி செய்யவும்.' : 'Ensure proper drainage to prevent waterlogging.'
            ],
            treatment: [
                isTa ? 'இலைப்புள்ளி நோய்க்கு மேன்கோசெப் தெளிக்கவும்.' : 'Spray Mancozeb for leaf spot control.',
                isTa ? 'இலை நோய்களுக்கு கார்பெண்டாசிம் கலவையை தெளிக்கவும்.' : 'Apply Carbendazim mixture for foliar diseases.'
            ],
            careTips: [
                isTa ? 'பூக்கும் நேரத்தில் நீர்ப்பாசனம் செய்யவும்.' : 'Ensure irrigation during flowering and pod formation.',
                isTa ? 'கிப்சம் உரமிடுவது நிலக்கடலை மகசூலுக்கு நல்லது.' : 'Apply Gypsum to improve pod filling.'
            ],
            harvestingTips: [
                isTa ? 'இலைகள் மஞ்சளடையும் போது அறுவடை செய்யவும்.' : 'Harvest when leaves turn yellow and pods are mature.',
                isTa ? 'அறுவடைக்கு பின் நிலக்கடலையை நிழலில் காயவைக்கவும்.' : 'Dry pods in shade after harvesting.'
            ],
            sustainablePractices: [
                isTa ? 'பசுந்தாள் உரங்களை ஊடுபயிராக நடவும்.' : 'Grow green manure as intercrop.',
                isTa ? 'ரைசோபியம் கலாச்சாரத்தை விதை நேர்த்தியில் பயன்படுத்தவும்.' : 'Use Rhizobium culture as seed inoculant.'
            ],
            irrigationStrategies: [
                isTa ? 'சொட்டு நீர்ப்பாசன முறையை பயன்படுத்தவும்.' : 'Use drip irrigation for water efficiency.',
                isTa ? 'மாலை நேர நீர்ப்பாசனத்தை தவிர்க்கவும்.' : 'Avoid evening irrigation to prevent fungal growth.'
            ],
            agriculturalInputs: [
                isTa ? 'கிப்சம்' : 'Gypsum',
                isTa ? 'ரைசோபியம்' : 'Rhizobium Inoculant',
                isTa ? 'DAP' : 'Di-Ammonium Phosphate (DAP)'
            ],
            diseases: [
                { name: isTa ? 'இலைப்புள்ளி நோய்' : 'Groundnut Leaf Spot', symptoms: isTa ? 'இலைகளில் வட்டமான பழுப்பு நிறப் புள்ளிகள்.' : 'Circular brown spots on leaves causing premature defoliation.' },
                { name: isTa ? 'மகுட் அழுகல் (Collar Rot)' : 'Collar Rot', symptoms: isTa ? 'செடியின் அடிப்பகுதியில் அழுகல் ஏற்படும்.' : 'Rotting at the base of the stem near the soil level.' }
            ]
        },
        'Chickpea': {
            prevention: [
                isTa ? 'நோய் எதிர்ப்பு ரகங்களைத் தேர்ந்தெடுக்கவும்.' : 'Select disease-resistant varieties.',
                isTa ? 'ட்ரைக்கோடெர்மா விரிடி மூலம் விதை நேர்த்தி செய்யவும்.' : 'Treat seeds with Trichoderma viride before sowing.',
                isTa ? 'நன்கு வடிகால் கொண்ட மண்ணில் பயிரிடவும்.' : 'Sow in well-drained soils to prevent root/collar rot.'
            ],
            treatment: [
                isTa ? 'அஸ்கோகைட்டா கருகல் நோய்க்கு மேன்கோசெப் தெளிக்கவும்.' : 'Spray Mancozeb for Ascochyta blight management.',
                isTa ? 'வேர் அழுகல் நோய்க்கு டிரைக்கோடெர்மா கரைசலை மண்ணில் ஊற்றவும்.' : 'Drench soil with Trichoderma solution for root/collar rot.'
            ],
            careTips: [
                isTa ? 'அதிகப்படியான நைட்ரஜன் உரத்தை தவிர்க்கவும்.' : 'Avoid excess nitrogen which promotes vegetative growth over pods.',
                isTa ? 'பூக்கும் பருவத்தில் நீர் அழுத்தம் கூடாது.' : 'Avoid water stress during the flowering stage.'
            ],
            harvestingTips: [
                isTa ? 'கூடுகள் பழுத்தவுடன் (90% பழுப்பு) அறுவடை செய்யவும்.' : 'Harvest when 90% of pods turn brown and dry.',
                isTa ? 'காலை நேரத்தில் அறுவடை செய்வது கூடு உடைவதை தடுக்கும்.' : 'Early morning harvesting reduces pod shattering.'
            ],
            sustainablePractices: [
                isTa ? 'பயறு வகை பயிர் சுழற்சி நடைமுறையைப் பின்பற்றவும்.' : 'Follow legume-based crop rotation practices.',
                isTa ? 'இயற்கை பூச்சி விரட்டிகளை (நீம்) பயன்படுத்தவும்.' : 'Use botanical pesticides like neem extract.'
            ],
            irrigationStrategies: [
                isTa ? 'அதிகப்படியான நீர்ப்பாசனம் நோய்க்கு வழிவகுக்கும்.' : 'Avoid excess irrigation which promotes fungal diseases.',
                isTa ? 'பூக்கும் நேரத்தில் மட்டும் நீர்ப்பாசனம் செய்யவும்.' : 'Irrigate only at critical stages like flowering.'
            ],
            agriculturalInputs: [
                isTa ? 'ட்ரைக்கோடெர்மா' : 'Trichoderma viride',
                isTa ? 'சூப்பர் பாஸ்பேட்' : 'Single Super Phosphate',
                isTa ? 'ரைசோபியம்' : 'Rhizobium culture'
            ],
            diseases: [
                { name: isTa ? 'அஸ்கோகைட்டா கருகல்' : 'Chickpea Ascochyta Blight', symptoms: isTa ? 'இலை, தண்டு மற்றும் கூடுகளில் தவிட்டு நிற புள்ளிகள்.' : 'Tan lesions with dark borders on leaves, stems and pods.' },
                { name: isTa ? 'பியூசேரியம் வாடல்' : 'Chickpea Fusarium Wilt', symptoms: isTa ? 'செடி திடீரென வாடுகிறது; தண்டின் உட்புறம் பழுப்பாகும்.' : 'Sudden wilting; internal stem discolouration to brown/dark.' },
                { name: isTa ? 'காலர் அழுகல்' : 'Chickpea Collar Rot', symptoms: isTa ? 'அடிமரத்தில் அழுகல்; நடவு கட்டத்தில் செடி இறக்கும்.' : 'Rotting at soil level; seedling death in early stages.' }
            ]
        },
        'Onion': {
            prevention: [
                isTa ? 'நோய் தாக்காத நாற்றுகளைத் தேர்ந்தெடுக்கவும்.' : 'Use disease-free seedlings for transplanting.',
                isTa ? 'மேன்கோசெப் மூலம் விதை மற்றும் நாற்று நேர்த்தி செய்யவும்.' : 'Treat seedlings with Mancozeb before transplanting.',
                isTa ? 'நடவுகள் நேரத்தில் மண்ணில் ஆழமாக நடாமல் பார்க்கவும்.' : 'Avoid deep planting to reduce basal rot risk.'
            ],
            treatment: [
                isTa ? 'ஊதா தழும்பு நோய்க்கு இப்ரோடையோன் தெளிக்கவும்.' : 'Spray Iprodione for purple blotch management.',
                isTa ? 'பாக்டீரியல் நோய்க்கு காப்பர் ஆக்ஸிகுளோரைடு பயன்படுத்தவும்.' : 'Use Copper Oxychloride for bacterial diseases.'
            ],
            careTips: [
                isTa ? 'அதிக தழைச்சத்து இடுவதை தவிர்க்கவும்.' : 'Avoid excessive nitrogen to prevent soft bulbs.',
                isTa ? 'களைகளை விரைவாக அகற்றவும்.' : 'Remove weeds promptly to reduce disease spread.'
            ],
            harvestingTips: [
                isTa ? 'இலைகள் விழும்போது அறுவடை செய்யவும்.' : 'Harvest when the tops naturally fall over.',
                isTa ? 'அறுவடைக்கு பின் 2-3 நாட்கள் வயலிலேயே காயவிடவும்.' : 'Cure bulbs in the field for 2-3 days before storage.'
            ],
            sustainablePractices: [
                isTa ? 'உயிரி பூஞ்சான் கொல்லிகளை ஊக்குவிக்கவும்.' : 'Promote the use of bio-fungicides.',
                isTa ? 'பயிர் சுழற்சி மூலம் மண் வாழ் நோய்களை கட்டுப்படுத்தவும்.' : 'Control soil-borne diseases through crop rotation.'
            ],
            irrigationStrategies: [
                isTa ? 'மழை நேரத்தில் நீர்ப்பாசனத்தை நிறுத்தவும்.' : 'Withhold irrigation during rainy periods.',
                isTa ? 'அறுவடைக்கு 15 நாட்கள் முன்பு நீர்ப்பாசனம் நிறுத்தவும்.' : 'Stop irrigation 15 days before harvest for better curing.'
            ],
            agriculturalInputs: [
                isTa ? 'போரான்' : 'Boron Micronutrient',
                isTa ? 'காப்பர் சல்பேட்' : 'Copper Sulphate',
                isTa ? 'N-P-K கலவை' : 'N-P-K Fertilizer'
            ],
            diseases: [
                { name: isTa ? 'ஊதா தழும்பு நோய்' : 'Onion Purple Blotch', symptoms: isTa ? 'இலைகளில் ஊதா நிற, நடுவில் வெள்ளை நிற புள்ளிகள் தோன்றும்.' : 'Elliptical, purple-centred lesions with whitish centres on leaves.' },
                { name: isTa ? 'இலைப்புள்ளி நோய்' : 'Leaf Spot', symptoms: isTa ? 'இலைகளில் சிறு மஞ்சள் அல்லது பழுப்பு நிற புள்ளிகள்.' : 'Small yellow or brown spots on leaves leading to tip dieback.' }
            ]
        },
        'Chili': {
            prevention: [
                isTa ? 'சான்றிதழ் பெற்ற நோய் எதிர்ப்பு விதைகளைப் பயன்படுத்தவும்.' : 'Use certified disease-resistant seeds.',
                isTa ? 'விதை நேர்த்திக்கு திரம் பயன்படுத்தவும்.' : 'Treat seeds with Thiram before sowing.',
                isTa ? 'தேமல் நோய் பரவலை தடுக்க திட்டுகளை ஆய்வு செய்யவும்.' : 'Scout fields regularly to detect and remove virus-infected plants.'
            ],
            treatment: [
                isTa ? 'ஊடுகொல்லி (Anthracnose) நோய்க்கு கார்பெண்டாசிம் தெளிக்கவும்.' : 'Spray Carbendazim for Anthracnose (die-back) control.',
                isTa ? 'ஃபைட்டோஃப்தோரா அழுகல் நோய்க்கு மெட்டாலாக்ஸில்+மேன்கோசெப் தெளிக்கவும்.' : 'Apply Metalaxyl+Mancozeb for Phytophthora blight.'
            ],
            careTips: [
                isTa ? 'பூக்கும் காலத்தில் நீர் அழுத்தம் கூடாது.' : 'Ensure no water stress during flowering stage.',
                isTa ? 'பூச்சி கட்டுப்பாட்டுக்கு மஞ்சள் நிற ஒட்டுப் பொறிகளை வைக்கவும்.' : 'Use yellow sticky traps to monitor and control thrips.'
            ],
            harvestingTips: [
                isTa ? 'பழங்கள் திட்டமான சிவப்பு நிறமடைந்தவுடன் பறிக்கவும்.' : 'Harvest when fruits attain full red colour.',
                isTa ? 'கணக்கான இடைவெளியில் பறிக்கவும்.' : 'Harvest at regular intervals to encourage new fruit set.'
            ],
            sustainablePractices: [
                isTa ? 'வேம்பு எண்ணெயை இயற்கை பூச்சி கட்டுப்பாட்டிற்கு பயன்படுத்தவும்.' : 'Use neem oil spray as an organic pesticide.',
                isTa ? 'ஊடுபயிர் முறையில் மக்காச்சோளம் நடவும்.' : 'Intercrop with maize as a windbreak to reduce virus spread.'
            ],
            irrigationStrategies: [
                isTa ? 'சொட்டு நீர்ப்பாசனம் மிளகாய்க்கு உகந்தது.' : 'Drip irrigation is most suitable for chili cultivation.',
                isTa ? 'வடிகால் வசதி இல்லாத நிலத்தில் பயிரிட வேண்டாம்.' : 'Avoid cultivating in poorly drained soils.'
            ],
            agriculturalInputs: [
                isTa ? 'கால்சியம் நைட்ரேட்' : 'Calcium Nitrate',
                isTa ? 'போரான்' : 'Boron',
                isTa ? 'வேம்பு எண்ணெய்' : 'Neem Oil'
            ],
            diseases: [
                { name: isTa ? 'ஊடுகொல்லி நோய் (Anthracnose)' : 'Chili Anthracnose', symptoms: isTa ? 'பழங்களில் ஆழமான வட்டமான சிவப்பு-பழுப்பு புண்கள்.' : 'Sunken, circular reddish-brown lesions on ripening fruits.' },
                { name: isTa ? 'மிளகாய் இலைத்தேமல்' : 'Leaf Spot', symptoms: isTa ? 'இலைகளில் சிறிய வட்டமான பழுப்பு புள்ளிகள்.' : 'Small circular brown spots with yellow halos on leaves.' }
            ]
        },
        'Soybean': {
            prevention: [
                isTa ? 'சான்றிதழ் பெற்ற, நோய் எதிர்ப்பு திறன் கொண்ட ரகங்களை பயன்படுத்தவும்.' : 'Use certified, rust-resistant soybean varieties.',
                isTa ? 'நிலத்தில் ஈரப்பதம் அதிகரிக்காமல் பார்க்கவும்.' : 'Avoid excess moisture conditions that encourage rust.',
                isTa ? 'முறையான பயிர் சுழற்சி மூலம் நோய் சுமையை குறைக்கவும்.' : 'Reduce disease pressure through proper crop rotation.'
            ],
            treatment: [
                isTa ? 'சோயா துரு நோய்க்கு டெபுகோனசோல் தெளிக்கவும்.' : 'Spray Tebuconazole for soybean rust management.',
                isTa ? 'இலை நோய்களுக்கு புரோபிகோனசோல் பயன்படுத்தவும்.' : 'Apply Propiconazole for foliar disease management.'
            ],
            careTips: [
                isTa ? 'பூக்கும் காலத்தில் சரியான சத்துக்கள் வழங்கவும்.' : 'Provide balanced nutrition during the flowering stage.',
                isTa ? 'வாரம் ஒரு முறை பயிர் கண்காணிப்பு செய்யவும்.' : 'Scout crop weekly for early disease detection.'
            ],
            harvestingTips: [
                isTa ? 'கூடுகள் மஞ்சளடைந்து காயும்போது அறுவடை செய்யவும்.' : 'Harvest when pods turn yellow to brown and are fully dry.',
                isTa ? '13% க்கும் குறைவான ஈரப்பதத்தில் தானியங்களை சேமிக்கவும்.' : 'Store grains at below 13% moisture to prevent mould.'
            ],
            sustainablePractices: [
                isTa ? 'பிராடிரைசோபியம் கலாச்சாரம் தரம் மண் வளம் அதிகரிக்க பயன்படுத்தவும்.' : 'Use Bradyrhizobium culture to fix atmospheric nitrogen.',
                isTa ? 'இயற்கை உரங்களை மட்டும் பயன்படுத்தவும்.' : 'Prioritize organic inputs to maintain soil health.'
            ],
            irrigationStrategies: [
                isTa ? 'துரு நோய் பரவலை தடுக்க மேல் நீர்ப்பாசனத்தை தவிர்க்கவும்.' : 'Avoid overhead irrigation to limit rust spread.',
                isTa ? 'வேர் பகுதியில் மட்டும் நீர் வழங்கவும்.' : 'Provide water directly at the root zone.'
            ],
            agriculturalInputs: [
                isTa ? 'பிராடிரைசோபியம்' : 'Bradyrhizobium Inoculant',
                isTa ? 'N-P-K கலவை' : 'N-P-K Fertilizer',
                isTa ? 'துத்தநாக சல்பேட்' : 'Zinc Sulphate'
            ],
            diseases: [
                { name: isTa ? 'சோயா துரு நோய்' : 'Soybean Rust', symptoms: isTa ? 'இலையின் அடியில் சிறும்புல் நிற துரு தூள் புள்ளிகள்.' : 'Rust-brown pustules on the lower leaf surface.' },
                { name: isTa ? 'இலைப்புள்ளி நோய்' : 'Leaf Spot', symptoms: isTa ? 'இலைகளில் பழுப்பு வட்ட புள்ளிகள் தோன்றி காய்ந்துவிடும்.' : 'Brown circular spots on leaves causing premature leaf drop.' }
            ]
        },
        'Black Gram': {
            prevention: [
                isTa ? 'நோய்த் தடுப்பு ரகங்களை விதைப்பதற்கு தேர்வு செய்யவும்.' : 'Select virus-tolerant or resistant black gram varieties.',
                isTa ? 'வெள்ளை ஈக்களை கட்டுப்படுத்துவது மொசைக் தடுக்கும்.' : 'Control whitefly vectors to prevent Yellow Mosaic Virus.',
                isTa ? 'விதை நேர்த்திக்கு கார்பெண்டாசிம் பயன்படுத்தவும்.' : 'Treat seeds with Carbendazim before sowing.'
            ],
            treatment: [
                isTa ? 'மஞ்சள் தேமல் நோய்க்கு பாதிக்கப்பட்ட செடிகளை உடனே அகற்றவும்.' : 'Uproot and destroy Yellow Mosaic Virus-infected plants immediately.',
                isTa ? 'புழு தாக்குதலுக்கு இமிடாக்ளோப்ரிட் தெளிக்கவும்.' : 'Spray Imidacloprid to control whitefly vectors.'
            ],
            careTips: [
                isTa ? 'அதிக நைட்ரஜன் தவிர்த்து பொட்டாஷ் அளவை சரியாக வைக்கவும்.' : 'Maintain balanced potassium levels; avoid excess nitrogen.',
                isTa ? 'சீரான இடைவெளியில் விதைக்கவும்.' : 'Maintain proper plant spacing for air circulation.'
            ],
            harvestingTips: [
                isTa ? 'கூடுகள் கருப்பு நிறமடைந்தவுடன் அறுவடை செய்யவும்.' : 'Harvest when pods turn dark/black and fully mature.',
                isTa ? 'காலை நேரத்தில் அறுவடை செய்வதால் உதிர்தல் தடுக்கலாம்.' : 'Harvest in early morning to minimize pod shattering.'
            ],
            sustainablePractices: [
                isTa ? 'நிலம் வளப்படுத்த பயறுவகைகளை ஊடுபயிராக நடவும்.' : 'Intercrop to improve soil fertility naturally.',
                isTa ? 'உயிரி உரங்களை ஊக்கமளிக்கவும்.' : 'Use bio-fertilizers like PSB and Rhizobium.'
            ],
            irrigationStrategies: [
                isTa ? 'சொட்டு நீர்ப்பாசனம் கருப்பு உழவுக்கு சிறந்தது.' : 'Drip irrigation is ideal for black gram cultivation.',
                isTa ? 'அதிக நீர்ப்பாசனம் தவிர்க்கவும்.' : 'Avoid waterlogging, especially in heavy clay soils.'
            ],
            agriculturalInputs: [
                isTa ? 'ரைசோபியம்' : 'Rhizobium culture',
                isTa ? 'சூப்பர் பாஸ்பேட்' : 'Single Super Phosphate',
                isTa ? 'MOP' : 'Muriate of Potash (MOP)'
            ],
            diseases: [
                { name: isTa ? 'மஞ்சள் தேமல் வைரஸ்' : 'Black Gram Yellow Mosaic Virus', symptoms: isTa ? 'இலைகளில் மஞ்சள் மற்றும் பச்சை இணைந்த தேமல் வடிவம்.' : 'Yellow and green mosaic mottling pattern on leaves.' },
                { name: isTa ? 'பொடிப்பூஞ்சை நோய்' : 'Black Gram Powdery Mildew', symptoms: isTa ? 'இலைகளில் வெள்ளை பொடி போன்ற பூஞ்சை படர்வு.' : 'White powdery fungal coating on leaves and stems.' }
            ]
        },
        'Green Gram': {
            prevention: [
                isTa ? 'நோய் எதிர்ப்பு திறன் கொண்ட ரகங்களை தேர்ந்தெடுக்கவும்.' : 'Select disease-resistant and high-yielding varieties.',
                isTa ? 'வைரஸ் பரவலை தடுக்க இமிடாக்ளோப்ரிட் தெளிக்கவும்.' : 'Spray Imidacloprid early to control whitefly virus vectors.',
                isTa ? 'சுத்தமான விதைகளை மட்டும் விதைப்பதற்கு பயன்படுத்தவும்.' : 'Use only certified clean seeds for sowing.'
            ],
            treatment: [
                isTa ? 'செர்கோஸ்போரா புள்ளி நோய்க்கு கார்பெண்டாசிம் தெளிக்கவும்.' : 'Spray Carbendazim for Cercospora leaf spot control.',
                isTa ? 'மஞ்சள் தேமல் நோய்க்கு பாதிக்கப்பட்ட செடிகளை அகற்றவும்.' : 'Remove and destroy YMV-infected plants promptly.'
            ],
            careTips: [
                isTa ? 'களைகளை முன்கூட்டியே அகற்றவும்.' : 'Weed early and regularly for a clean crop.',
                isTa ? 'பூக்கும் கட்டத்தில் நீர் அழுத்தம் இல்லாமல் பார்க்கவும்.' : 'Ensure no water stress at the flowering stage.'
            ],
            harvestingTips: [
                isTa ? '75% கூடுகள் கருப்பாகும்போது அறுவடை செய்யவும்.' : 'Harvest when 75-80% of pods turn dark.',
                isTa ? 'இரண்டு அல்லது மூன்று முறை கட்டுவதன் மூலம் கூடுதல் மகசூல் பெறலாம்.' : 'Multiple pickings can increase total yield.'
            ],
            sustainablePractices: [
                isTa ? 'ரைசோபியம் மற்றும் PSB கலாச்சாரங்களை பயன்படுத்தவும்.' : 'Use Rhizobium and PSB cultures for better yield.',
                isTa ? 'மண் வளப்படுத்துவதற்கு பசுந்தாள் உரமிடவும்.' : 'Incorporate green manure to improve soil fertility.'
            ],
            irrigationStrategies: [
                isTa ? 'சொட்டு நீர்ப்பாசனம் பாசிப்பயறுக்கு சிறந்தது.' : 'Drip irrigation is effective for green gram.',
                isTa ? 'தண்ணீர் தேங்குவதை தவிர்க்கவும்.' : 'Avoid waterlogging in the field.'
            ],
            agriculturalInputs: [
                isTa ? 'ரைசோபியம்' : 'Rhizobium culture',
                isTa ? 'சூப்பர் பாஸ்பேட்' : 'Super Phosphate',
                isTa ? 'பொட்டாஷ்' : 'Potash'
            ],
            diseases: [
                { name: isTa ? 'மஞ்சள் தேமல் வைரஸ்' : 'Green Gram Yellow Mosaic Virus', symptoms: isTa ? 'இலைகளில் மஞ்சள்-பச்சை தேமல் வடிவம்; கூடு பிடிப்பு குறையும்.' : 'Yellow-green mosaic on leaves; severely reduces pod set.' },
                { name: isTa ? 'செர்கோஸ்போரா இலைப்புள்ளி நோய்' : 'Green Gram Cercospora Leaf Spot', symptoms: isTa ? 'இலைகளில் சிறிய வட்டமான கருஞ்சிவப்பு புள்ளிகள்.' : 'Small circular dark-brown spots with reddish borders on leaves.' }
            ]
        },
        'Sunflower': {
            prevention: [
                isTa ? 'நோய் எதிர்ப்பு சூரியகாந்தி ஒட்டு ரகங்களை தேர்ந்தெடுக்கவும்.' : 'Select disease-resistant hybrid sunflower varieties.',
                isTa ? 'விதை நேர்த்திக்கு திரம் அல்லது கார்பெண்டாசிம் பயன்படுத்தவும்.' : 'Treat seeds with Thiram or Carbendazim before sowing.',
                isTa ? 'நோய் தாக்கிய தாவர எச்சங்களை புலத்தில் இருந்து அகற்றவும்.' : 'Remove and destroy crop residues after harvest.'
            ],
            treatment: [
                isTa ? 'ஆல்டர்னேரியா புள்ளி நோய்க்கு மேன்கோசெப் தெளிக்கவும்.' : 'Spray Mancozeb for Alternaria leaf spot control.',
                isTa ? 'தண்டு அழுகல் நோய்க்கு கார்பெண்டாசிம் பயன்படுத்தவும்.' : 'Apply Carbendazim for stem rot management.'
            ],
            careTips: [
                isTa ? 'கூடு தலை திரும்பும் (கேபிடல்) கட்டத்தில் நீர்ப்பாசனம் செய்யவும்.' : 'Irrigate during head formation (capitulum stage).',
                isTa ? 'முறையான இடைவெளியில் விதைத்து காற்றோட்டம் அதிகரிக்கவும்.' : 'Maintain proper inter-plant spacing for air circulation.'
            ],
            harvestingTips: [
                isTa ? 'கூடின் பின் பாகம் மஞ்சளடையும்போது அறுவடை செய்யவும்.' : 'Harvest when the back of the head turns yellow-brown.',
                isTa ? 'விதைகளில் ஈரப்பதம் 10% க்கும் குறைவாக இருக்க வேண்டும்.' : 'Ensure seed moisture is below 10% before storage.'
            ],
            sustainablePractices: [
                isTa ? 'ஊடுபயிராக பருப்பு வகைகளை வளர்க்கவும்.' : 'Grow legumes as intercrops to enhance soil fertility.',
                isTa ? 'தேனீ மகரந்த சேர்க்கையை ஊக்குவிக்க ஊடுபயிர் செய்யவும்.' : 'Encourage bee pollination for better seed set.'
            ],
            irrigationStrategies: [
                isTa ? 'முக்கிய வளர்ச்சி கட்டங்களில் நீர்ப்பாசனம் செய்யவும்.' : 'Irrigate at critical growth stages: germination, flowering, seed filling.',
                isTa ? 'அதிக நீர்ப்பாசனம் தண்டு அழுகலை ஊக்குவிக்கும்.' : 'Excess irrigation can promote stem and root rot.'
            ],
            agriculturalInputs: [
                isTa ? 'N-P-K கலவை (60:60:30 கிலோ/ஹெக்.)' : 'N-P-K Fertilizer (60:60:30 kg/ha)',
                isTa ? 'போரான்' : 'Boron Micronutrient',
                isTa ? 'அமோனியம் சல்பேட்' : 'Ammonium Sulphate'
            ],
            diseases: [
                { name: isTa ? 'ஆல்டர்னேரியா இலைப்புள்ளி நோய்' : 'Sunflower Alternaria Leaf Spot', symptoms: isTa ? 'இலைகளில் கருப்பு-பழுப்பு வட்டமான புள்ளிகள்.' : 'Dark brown to black circular spots with yellow halos on leaves.' },
                { name: isTa ? 'தண்டு அழுகல் நோய்' : 'Sunflower Stem Rot', symptoms: isTa ? 'தண்டின் அடியில் அழுகல்; செடி சோர்ந்து கீழே விழும்.' : 'Rotting at stem base; plant wilts and lodges under wind.' }
            ]
        }
    };

    const defaultData = {
        prevention: [isTa ? 'முறையான மண் ஆய்வு செய்யவும்.' : 'Conduct regular soil testing.', isTa ? 'தரமான விதைகளைத் தேர்ந்தெடுக்கவும்.' : 'Select high-quality certified seeds.'],
        treatment: [isTa ? 'அறிவிக்கப்பட்ட பூஞ்சான் கொல்லிகளைப் பயன்படுத்தவும்.' : 'Use recommended fungicides.', isTa ? 'பாதிக்கப்பட்ட செடிகளை அகற்றவும்.' : 'Remove and destroy affected plants.'],
        careTips: [isTa ? 'களைகளைக் கட்டுப்படுத்தவும்.' : 'Keep the field weed-free.', isTa ? 'முறையான நீர்ப்பாசனம் செய்யவும்.' : 'Ensure proper and timely irrigation.'],
        harvestingTips: [isTa ? 'சரியான பக்குவத்தில் அறுவடை செய்யவும்.' : 'Harvest at the right maturity stage.'],
        sustainablePractices: [isTa ? 'இயற்கை உரங்களைப் பயன்படுத்தவும்.' : 'Use more bio-fertilizers.'],
        irrigationStrategies: [isTa ? 'நீரைச் சிக்கனமாகப் பயன்படுத்தவும்.' : 'Optimize water usage.'],
        agriculturalInputs: [isTa ? 'N-P-K உரங்கள்' : 'N-P-K Fertilizers'],
        diseases: []
    };

    const selectedData = cropData[crop] || defaultData;
    const enrichedData = {
        ...selectedData,
        diseases: (selectedData.diseases || []).map((disease) => ({
            ...disease,
            image: resolveDiseaseImage(crop, disease.name)
        }))
    };

    res.json(enrichedData);
});

// --- END MISSING ENDPOINTS FIX ---

app.use((err, req, res, next) => {
    console.error('Server Error:', err);

    // Handle multer errors
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size too large. Maximum 10MB allowed.' });
    }

    if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'Too many files uploaded.' });
    }

    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Unexpected file field.' });
    }

    // Generic error response
    return res.status(500).json({
        error: 'Server error occurred. Please try again later.'
    });
});

// Handle 404 routes

// --- WEATHER AND CLIMATE API ---
function weatherCodeToText(code) {
    const c = Number(code);
    if (c === 0) return 'Clear';
    if (c === 1 || c === 2) return 'Partly Cloudy';
    if (c === 3) return 'Cloudy';
    if (c >= 45 && c <= 48) return 'Fog';
    if (c >= 51 && c <= 67) return 'Rain';
    if (c >= 71 && c <= 77) return 'Snow';
    if (c >= 80 && c <= 82) return 'Showers';
    if (c >= 95) return 'Thunderstorm';
    return 'Mixed';
}

app.get('/api/weather', async (req, res) => {
    try {
        const { lat, lng } = req.query;
        if (lat === undefined || lng === undefined || lat === '' || lng === '') {
            return res.status(400).json({ error: 'Latitude and longitude are required for weather forecast.' });
        }

        const url = `https://api.open-meteo.com/v1/forecast?latitude=${Number(lat).toFixed(2)}&longitude=${Number(lng).toFixed(2)}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum&timezone=auto`;
        const response = await axios.get(url);
        const data = response.data;

        if (data.error) {
            throw new Error('Open-Meteo API Error');
        }

        const current = data.current || {};
        const daily = data.daily || {};
        const forecast = [];
        for (let i = 0; i < 3; i++) {
            if (!daily.time || !daily.time[i]) break;
            forecast.push({
                date: daily.time[i],
                day: i === 0 ? 'Today' : (i === 1 ? 'Tomorrow' : new Date(daily.time[i]).toLocaleDateString(undefined, { weekday: 'long' })),
                tempMin: Number(daily.temperature_2m_min?.[i]?.toFixed ? daily.temperature_2m_min[i].toFixed(1) : Number(daily.temperature_2m_min?.[i] || 0).toFixed(1)),
                tempMax: Number(daily.temperature_2m_max?.[i]?.toFixed ? daily.temperature_2m_max[i].toFixed(1) : Number(daily.temperature_2m_max?.[i] || 0).toFixed(1)),
                rainChance: Number(((daily.precipitation_probability_max?.[i] ?? 0) / 100).toFixed(2)),
                rain: Number((daily.precipitation_sum?.[i] ?? 0).toFixed(1)),
                code: daily.weather_code?.[i] ?? 0,
                condition: weatherCodeToText(daily.weather_code?.[i] ?? 0)
            });
        }

        res.json({
            temperature: Number((current.temperature_2m ?? 0).toFixed ? current.temperature_2m.toFixed(1) : Number(current.temperature_2m || 0).toFixed(1)),
            temp: `${Number(current.temperature_2m || 0).toFixed(1)}Â°C`,
            humidity: current.relative_humidity_2m ?? null,
            rain: `${Number(current.precipitation || 0).toFixed(1)}mm`,
            precipitation: Number((current.precipitation || 0).toFixed(1)),
            status: 'Live',
            city: 'Your Location',
            region: 'Current Area',
            forecast
        });
    } catch (e) {
        console.error('Weather error:', e);
        return res.status(503).json({ error: 'Unable to load live forecast right now.' });
    }
});




app.use((req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

const HOST = '0.0.0.0';
const START_PORT = Number.parseInt(process.env.PORT, 10) || 3000;

function startServer(port) {
    const server = app.listen(port, HOST, () => {
        const address = server.address();
        const activePort = address && typeof address === 'object' ? address.port : port;

        if (activePort !== port) {
            console.warn(`Port ${port} was requested, but ${activePort} is active instead.`);
        }

        console.log(`\n✅ IoT Crop Recommendation server running at http://localhost:${activePort}`);
        console.log(`✅ Server is READY! Open your browser to: http://localhost:${activePort}\n`);
        console.log(`✅ Server accessible at: http://0.0.0.0:${activePort} or http://127.0.0.1:${activePort}`);
    });

    server.on('error', (error) => {
        console.error('Server error event:', error);
        if (error.code === 'EADDRINUSE') {
            const nextPort = port + 1;
            console.warn(`Port ${port} is already in use. Trying ${nextPort}...`);
            setTimeout(() => startServer(nextPort), 250);
        }
    });

    server.on('listening', () => {
        console.log('✅ HTTP listener is active\n');
    });

    return server;
}

async function bootstrapServer() {
    await connectMongoDB();
    startServer(START_PORT);
}

bootstrapServer().catch((error) => {
    console.error('Failed to initialize server startup:', error);
    process.exit(1);
});

// Global process error handlers
process.on('uncaughtException', (error) => {
    console.error('DEBUG: Uncaught Exception:', error.message, error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('DEBUG: Unhandled Rejection:', reason);
});

console.log('✅ Server initialized and ready to start...');



