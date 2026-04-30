const fs = require('fs');

const goodCode = `const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fsModule = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');

// Initialize Google Gemini
const genai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || 'dummy-key-to-prevent-crash'
});

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'dummy-key-to-prevent-crash'
});

const Database = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database();

let emailTransporter = null;
let emailMode = 'pending';

async function initEmailTransporter() {
    const gmailUser = process.env.EMAIL_USER;
    const gmailPass = process.env.EMAIL_PASS;
    const hasGmailCreds = gmailUser &&
        gmailPass &&
        !gmailUser.includes('your_gmail') &&
        !gmailPass.includes('your_16');

    if (hasGmailCreds) {
        const gmailTransporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: { user: gmailUser, pass: gmailPass }
        });

        try {
            await gmailTransporter.verify();
            emailTransporter = gmailTransporter;
            emailMode = 'gmail';
            console.log('✅ Gmail SMTP ready →', gmailUser);
            return;
        } catch (err) {
            console.warn('⚠️  Gmail SMTP failed:', err.message);
        }
    }

    try {
        const testAccount = await nodemailer.createTestAccount();
        emailTransporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: { user: testAccount.user, pass: testAccount.pass }
        });
        emailMode = 'ethereal';
    } catch (err) {
        emailMode = 'disabled';
    }
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
if (!db.findUserByEmail(testEmail)) {
    db.createUser({
        name: 'Test User',
        username: 'testuser',
        email: testEmail,
        password: bcrypt.hashSync('password123', 10)
    });
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1082258284534-vunbjv19l2v3f089k9b4b0p9b4b0p9b4.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fsModule.existsSync(uploadsDir)) {
    fsModule.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = (file.originalname && path.extname(file.originalname)) || '.jpg';
        cb(null, \`crop-\${Date.now()}-\${Math.floor(Math.random() * 1e9)}\${ext}\`);
    }
});
const upload = multer({ storage });

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
            
            const response = await fetch(\`https://my-api.plantnet.org/v2/identify/all?api-key=\${apiKey}\`, {
                method: 'POST',
                body: form
            });
            
            if (!response.ok) return null;

            const data = await response.json();
            const bestMatch = data.results?.[0];
            if (bestMatch) {
                return {
                    crop_name: bestMatch.species.commonNames?.[0] || bestMatch.species.scientificNameWithoutAuthor || 'Unknown Crop',
                    scientific_name: bestMatch.species.scientificNameWithoutAuthor,
                    confidence: Math.round(bestMatch.score * 100) + '%',
                    source: 'PlantNet Expert API'
                };
            }
        }
    } catch (e) {
    }
    return null;
}

app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(\`📨 \${req.method} \${req.path} - \${res.statusCode} (\${duration}ms)\`);
    });
    next();
});

app.post('/api/soil-analysis', (req, res) => {
    try {
        const body = req.body || {};
        const { n, p, k, ph, oc, ec, lang = 'en' } = body;
        const isTa = lang === 'ta';

        const n_val = parseFloat(n) || 0;
        const p_val = parseFloat(p) || 0;
        const k_val = parseFloat(k) || 0;
        const ph_val = parseFloat(ph) || 7.0;
        const oc_val = parseFloat(oc) || 0.5;
        const ec_val = parseFloat(ec) || 0.5;

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

        let phStatus = '';
        if (ph_val < 6.0) { score -= 15; phStatus = isTa ? 'அமிலத் தன்மை' : 'Acidic'; }
        else if (ph_val > 8.0) { score -= 15; phStatus = isTa ? 'காரத் தன்மை' : 'Alkaline'; }
        else phStatus = isTa ? 'சரியான நிலை' : 'Neutral/Balanced';

        if (oc_val < 0.5) score -= 10;
        else score += 5;

        score = Math.max(Math.min(score, 100), 10);

        const insights = [
            {
                title: isTa ? 'pH மேலாண்மை' : 'pH Management',
                text: ph_val < 6.0 ? (isTa ? 'மண்ணின் அமிலத்தன்மையைக் குறைக்க சுண்ணாம்பு (Lime) சேர்க்கவும்.' : 'Apply Lime to reduce soil acidity.') :
                    ph_val > 8.0 ? (isTa ? 'மண்ணின் காரத்தன்மையைக் குறைக்க ஜிப்சம் (Gypsum) சேர்க்கவும்.' : 'Apply Gypsum to reduce alkalinity.') :
                        (isTa ? 'மண்ணின் pH சரியான நிலையில் உள்ளது. இதைத் தொடரவும்.' : 'pH is optimal. Maintain current organic practices.'),
                icon: 'fa-vial', color: 'primary'
            },
            {
                title: isTa ? 'ஊட்டச்சத்து திருத்தம்' : 'Nutrient Correction',
                text: n_val < 150 ? (isTa ? 'தழைச்சத்து குறைவாக உள்ளது. யூரியா அல்லது வேப்பம் புண்ணாக்கு பயன்படுத்தவும்.' : 'Nitrogen is low. Use Urea or Neem cake.') :
                    (isTa ? 'ஊட்டச்சத்துக்கள் ஓரளவிற்கு திருப்திகரமாக உள்ளன.' : 'Nutrient levels are generally satisfactory.'),
                icon: 'fa-capsules', color: 'info'
            },
            {
                title: isTa ? 'கரிமப் பொருள்' : 'Organic Matter',
                text: oc_val < 0.6 ? (isTa ? 'கரிம கார்பன் குறைவாக உள்ளது. தொழு உரம் அல்லது மண்புழு உரம் சேர்க்கவும்.' : 'Organic carbon is low. Add FYM or Vermicompost.') :
                    (isTa ? 'மண்ணில் போதுமான கரிமப் பொருட்கள் உள்ளன.' : 'Sufficient organic matter detected in soil.'),
                icon: 'fa-leaf', color: 'success'
            },
            {
                title: isTa ? 'பயிர் பொருத்தம்' : 'Crop Suitability',
                text: ph_val >= 6.0 && ph_val <= 7.5 ? (isTa ? 'இந்த மண் நெல், கரும்பு மற்றும் காய்கறிகளுக்கு மிகவும் ஏற்றது.' : 'Excellent for Rice, Sugarcane, and most Vegetables.') :
                    (isTa ? 'பருப்பு வகைகளை பயிரிடுவதன் மூலம் மண் வளத்தை மேம்படுத்தலாம்.' : 'Consider pulses to improve soil texture and health.'),
                icon: 'fa-seedling', color: 'warning'
            }
        ];

        res.json({
            score: score,
            status: score > 80 ? (isTa ? 'மிக நன்று' : 'Excellent') : score > 60 ? (isTa ? 'நன்று' : 'Good') : (isTa ? 'மண் வளம் கூட்டப்பட வேண்டும்' : 'Needs Improvement'),
            statusColor: score > 80 ? 'success' : score > 60 ? 'primary' : 'warning',
            nutrients: nutrients,
            insights: insights
        });
    } catch (e) {
        res.status(500).json({ error: 'Internal soil analysis error' });
    }
});

app.post('/api/upload-photo', upload.single('cropPhoto'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No photo uploaded' });
        }

        const apiKey = process.env.GEMINI_API_KEY || '';
        const isConfigured = apiKey && apiKey !== 'your-gemini-api-key-here' && !apiKey.startsWith('dummy');

        if (!isConfigured) {
            console.warn("GEMINI_API_KEY not configured, returning dummy AI response as requested.");
            if (req.file && fsModule.existsSync(req.file.path)) {
                fsModule.unlinkSync(req.file.path);
            }
            return res.json({ 
                success: true, 
                photoData: {
                    crop_name: "Crop (Dummy Data)",
                    scientific_name: "Unknown",
                    confidence: "100%",
                    growth_stage: "Active",
                    disease_detected: "Yes",
                    disease_name: "Leaf Spot",
                    severity: "Moderate",
                    disease_cause: "Fungal infection from damp conditions.",
                    treatment: {
                        organic: "Use appropriate pesticide and maintain soil moisture",
                        chemical: "N/A",
                        prevention: "Standard pest monitoring.",
                        immediate_actions: "Use appropriate pesticide and maintain soil moisture"
                    },
                    care_tips: {
                        watering: "Follow standard regional irrigation.",
                        soil: "Check soil moisture levels.",
                        sunlight: "Ensure adequate exposure.",
                        maintenance: "Standard regional upkeep."
                    },
                    notes: "This is a dummy response returned because no API keys were configured."
                } 
            });
        }

        const imageBase64 = fsModule.readFileSync(req.file.path, { encoding: 'base64' });
        const mimeType = req.file.mimetype;`;

const text = fs.readFileSync('server.js', 'utf8');
const searchString = "app.post('/api/upload-photo'";
const idx = text.indexOf(searchString);

if (idx !== -1) {
    const endIdx = text.indexOf("const mimeType = req.file.mimetype;", idx);
    const after = text.substring(endIdx + "const mimeType = req.file.mimetype;".length);
    fs.writeFileSync('server.js', goodCode + after);
    console.log("Restored lines 1 through api/upload-photo cleanly!");
} else {
    // If not found, search fallback
    const idx2 = text.indexOf("const imageBase64 =");
    if (idx2 !== -1) {
        const after = text.substring(idx2);
        fs.writeFileSync('server.js', goodCode + "\\n" + after);
        console.log("Restored lines 1 through api/upload-photo using fallback!");
    } else {
        console.log("Failed to find injection point.");
    }
}
