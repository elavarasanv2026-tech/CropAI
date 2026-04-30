const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const axios = require('axios'); // To call Python AI Service
const { SensorData, CropHealth, YieldPrediction, Alert, User, FinancialRecord } = require('./database_schema');
const { calculateProfitMargin } = require('./financial_utils'); // Simple helper

/* 
   ==================================================
   1. Real-time IoT Monitoring API
   ==================================================
*/
// GET /api/sensors/:userId - Retrieve latest sensor data
router.get('/sensors/:userId', async (req, res) => {
    try {
        const sensors = await SensorData.findOne({ userId: req.params.userId }).sort({ timestamp: -1 });
        if (!sensors) return res.status(404).json({ message: 'No sensor data found' });
        res.json(sensors);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sensors/data - Receive data from IoT Hardware (ESP32/Arduino)
router.post('/sensors/data', async (req, res) => {
    try {
        const { deviceId, readings } = req.body;
        // Validation logic
        if (!deviceId || !readings) throw new Error("Invalid sensor payload");

        const newReading = new SensorData({ deviceId, readings });
        await newReading.save();

        // **Trigger Smart Alert Logic** 
        // Example: Call Python Anomaly Detection Service asynchronously
        // axios.post('http://localhost:5000/detect_iot_anomalies', { ...readings })
        //      .then(response => { if(response.data.alerts.length > 0) createAlert(response.data.alerts[0]); });

        res.status(201).json({ success: true, id: newReading._id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});


/* 
   ==================================================
   2. Advanced Photo Disease Detection API
   ==================================================
*/
// POST /api/disease-detection - Upload image for analysis
router.post('/disease-detection', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

        // Call the Python AI Microservice
        // Form-data handling required here (using 'form-data' library usually)
        /* 
        const formData = new FormData();
        formData.append('image', fs.createReadStream(req.file.path));
        const aiResponse = await axios.post('http://localhost:5000/predict_disease', formData, { ...headers });
        */

        // Mock AI Response for now
        const mockAIResponse = {
            diseaseName: "Early Blight",
            confidence: 88.5,
            healthScore: 45,
            treatment: "Apply fungicide Mancozeb 75 WP @ 2g/liter water.",
            fertilizer: "Reduce Nitrogen application."
        };

        // Save to Database History
        const healthRecord = new CropHealth({
            userId: req.user._id, // Assume Auth Middleware populates req.user
            cropName: req.body.cropName || 'Unknown',
            imageUrl: req.file.path,
            analysisResult: mockAIResponse,
            status: mockAIResponse.healthScore < 50 ? 'Critical' : (mockAIResponse.healthScore < 80 ? 'Warning' : 'Healthy')
        });
        await healthRecord.save();

        res.json(healthRecord);

    } catch (err) {
        res.status(500).json({ error: 'Disease detection failed: ' + err.message });
    }
});


/* 
   ==================================================
   3. Predictive Yield Forecast API
   ==================================================
*/
router.post('/yield-forecast', async (req, res) => {
    try {
        const { cropName, farmArea, soilMoisture, rainfall } = req.body;

        // Validations
        if (!cropName || !farmArea) return res.status(400).json({ error: "Missing required parameters" });

        // Call Python Yield Prediction Model
        // const prediction = await axios.post('http://localhost:5000/predict_yield', { crop: cropName, area: farmArea ... });

        // Mock Prediction
        const prediction = {
            expectedYield: 5600, // Kg
            harvestDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
            confidence: { min: 5000, max: 6200 }
        };

        const record = new YieldPrediction({
            userId: req.user._id,
            cropName,
            forecast: prediction,
            targetHarvestDate: prediction.harvestDate
        });
        await record.save();

        res.json(record);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/* 
   ==================================================
   4. Analytics & Financial APIs
   ==================================================
*/
// POST /api/finance/calculate-profit - Cost & Profit Calculator
router.post('/finance/calculate-profit', (req, res) => {
    const { seedCost, fertilizerCost, laborCost, waterCost, estimatedYield, marketPrice } = req.body;

    const totalCost = Number(seedCost) + Number(fertilizerCost) + Number(laborCost) + Number(waterCost);
    const estimatedRevenue = Number(estimatedYield) * Number(marketPrice);
    const profit = estimatedRevenue - totalCost;
    const margin = (profit / estimatedRevenue) * 100;

    res.json({
        totalCost,
        estimatedRevenue,
        projectedProfit: profit,
        profitMarginPercentage: margin.toFixed(2),
        breakEvenYield: (totalCost / marketPrice).toFixed(2)
    });
});

// GET /api/analytics/monthly-performance
router.get('/analytics/monthly-performance', async (req, res) => {
    // Aggregation pipeline to group financial records by month
    const performance = await FinancialRecord.aggregate([
        { $match: { userId: req.user._id } },
        {
            $group: {
                _id: { $month: "$date" },
                totalExpenses: { $sum: "$totalExpenses" }, // Assuming schema field existence
                totalIncome: { $sum: "$totalIncome" }
            }
        },
        { $sort: { _id: 1 } }
    ]);
    res.json(performance);
});


/* 
   ==================================================
   5. Weather Integration API
   ==================================================
*/
router.get('/weather/forecast', async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: "Location required" });

    // Call OpenWeatherMap or similar
    // const weather = await axios.get(`https://api.openweathermap.org/data/2.5/onecall?lat=${lat}&lon=${lon}&appid=${process.env.OPENWEATHER_KEY}`);

    // Mock Weather Response
    res.json({
        current: { temp: 28, humidity: 65, condition: "Partly Cloudy" },
        forecast: [
            { day: "Today", rainProb: 10, irrigation: "Not needed" },
            { day: "Tomorrow", rainProb: 80, irrigation: "SKIP IRRIGATION - Heavy Rain Expected" }
        ]
    });
});

module.exports = router;
