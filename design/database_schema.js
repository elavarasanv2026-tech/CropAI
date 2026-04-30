// database.js (Mongoose Schema Design)
const mongoose = require('mongoose');

// 1. User Schema (Enhanced for Profile & Preferences)
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    fullName: String,
    phone: String,
    farmDetails: {
        location: {
            lat: Number,
            lng: Number,
            address: String
        },
        sizeAcres: Number,
        soilType: { type: String, enum: ['Clay', 'Sandy', 'Loamy', 'Silt', 'Peat', 'Chalk'] },
        primaryCrops: [String],
        irrigationType: { type: String, enum: ['Rainfed', 'Drip', 'Sprinkler', 'Canal'] }
    },
    preferences: {
        language: { type: String, default: 'en' },
        notifications: {
            email: { type: Boolean, default: true },
            sms: { type: Boolean, default: false },
            push: { type: Boolean, default: true }
        }
    },
    createdAt: { type: Date, default: Date.now }
});

// 2. Crop Health & Disease History Schema
const cropHealthSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    cropName: { type: String, required: true },
    date: { type: Date, default: Date.now },
    imageUrl: String,
    analysisResult: {
        diseaseName: String,
        confidence: Number, // 0-100
        healthScore: Number, // 0-100
        issuesDetected: [String],
        recommendations: {
            treatment: String,
            fertilizer: String,
            preventiveMeasures: [String]
        }
    },
    status: { type: String, enum: ['Healthy', 'Warning', 'Critical'], default: 'Healthy' }
});

// 3. IoT Sensor Data Schema (Time-Series Optimized)
const sensorDataSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    timestamp: { type: Date, default: Date.now, index: true },
    readings: {
        soilMoisture: Number, // Percentage
        temperature: Number, // Celsius
        humidity: Number, // Percentage
        phLevel: Number,     // 0-14
        nitrogen: Number,    // mg/kg (optional)
        phosphorus: Number,  // mg/kg (optional)
        potassium: Number    // mg/kg (optional)
    },
    batteryLevel: Number
}, { timeseries: { timeField: 'timestamp', metaField: 'deviceId', granularity: 'minutes' } });

// 4. Yield Prediction Schema
const yieldPredictionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cropName: String,
    predictionDate: { type: Date, default: Date.now },
    targetHarvestDate: Date,
    forecast: {
        expectedYield: Number, // in kg/acre
        confidenceInterval: { min: Number, max: Number },
        factors: {
            weatherImpact: String,
            soilHealth: String,
            pestRisk: String
        }
    },
    actualYield: Number // Updated after harvest for retraining
});

// 5. Smart Alerts Schema
const alertSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: { type: String, enum: ['Weather', 'Disease', 'Imrigation', 'Nutrient', 'Market'] },
    severity: { type: String, enum: ['Info', 'Warning', 'Critical'] },
    message: String,
    timestamp: { type: Date, default: Date.now },
    isRead: { type: Boolean, default: false },
    actionLink: String // Optional URL to take action
});

// 6. Financial Analytics Schema
const financialRecordSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    season: String, // e.g., "Kharif 2024"
    cropName: String,
    expenses: [{
        category: { type: String, enum: ['Seeds', 'Fertilizer', 'Pesticides', 'Labor', 'Water', 'Equipment', 'Other'] },
        amount: Number,
        date: Date,
        description: String
    }],
    income: [{
        source: String, // e.g., "Market Sale", "Subsidy"
        amount: Number,
        date: Date,
        quantitySold: Number,
        unitPrice: Number
    }],
    totalProfit: Number,
    profitMargin: Number
});

// Export Models
const User = mongoose.model('User', userSchema);
const CropHealth = mongoose.model('CropHealth', cropHealthSchema);
const SensorData = mongoose.model('SensorData', sensorDataSchema);
const YieldPrediction = mongoose.model('YieldPrediction', yieldPredictionSchema);
const Alert = mongoose.model('Alert', alertSchema);
const FinancialRecord = mongoose.model('FinancialRecord', financialRecordSchema);

module.exports = { User, CropHealth, SensorData, YieldPrediction, Alert, FinancialRecord };
