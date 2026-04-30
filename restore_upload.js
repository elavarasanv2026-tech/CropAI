const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const startIdx = code.indexOf("app.post('/api/upload-photo'");
const endStr = "// --- AI Agriculture Chat Assistant (Tamil Specialist) ---";
const endIdx = code.indexOf(endStr);

if (startIdx !== -1 && endIdx !== -1) {
    const before = code.substring(0, startIdx);
    const after = code.substring(endIdx);

    const goodFunction = `app.post('/api/upload-photo', upload.single('cropPhoto'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No photo uploaded' });
        }

        const apiKey = process.env.GEMINI_API_KEY || '';
        const isConfigured = apiKey && apiKey !== 'your-gemini-api-key-here' && !apiKey.startsWith('dummy');

        if (!isConfigured) {
            console.warn("GEMINI_API_KEY not configured, returning dummy AI response as requested.");
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
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

        const imageBase64 = fs.readFileSync(req.file.path, { encoding: 'base64' });
        const mimeType = req.file.mimetype;

        let plantnetLabel = null;
        try {
            const externalCrop = await callExternalCropAPI(req.file.path, 'plantnet');
            if (externalCrop && externalCrop.confidence.replace('%', '') > 30) {
                plantnetLabel = externalCrop;
                console.log(\`🤖 PlantNet Species Match: \${plantnetLabel.crop_name} (\${plantnetLabel.confidence})\`);
            }
        } catch (pe) {
            console.warn("PlantNet enrichment failed, proceeding with Gemini-only:", pe.message);
        }

        const promptAddition = plantnetLabel ? 
            \`\\n⚠️ SPECIALIST NOTE: PlantNet species identification indicates this is likely '\${plantnetLabel.crop_name}' (\${plantnetLabel.scientific_name}). Use this to focus your disease analysis.\` : 
            '';

        const prompt = \`
            You are an expert AI system specialized ONLY in agricultural pathology and crop health.
            Analyze the uploaded image carefully.\${promptAddition}

            🚫 RESTRICTIONS:
            - Do NOT classify animals, humans, or non-plant objects.
            - If not an agricultural plant, return the Invalid Detection JSON below.

            🌱 1. CROP IDENTIFICATION:
            - Final identity (common + scientific name).
            - Growth stage (Seedling/Vegetative/Flowering/Fruiting/Harvest).

            🦠 2. PATHOLOGICAL ANALYSIS:
            - Detect visible symptoms (spots, wilting, discoloration, pests).
            - Identify exact disease name and severity level.

            📊 FINAL OUTPUT FORMAT (STRICT JSON):
            {
              "crop_name": "Common Crop Name",
              "scientific_name": "Scientific Name",
              "confidence": "95%",
              "growth_stage": "Vegetative/Flowering/etc",
              "disease_detected": "Yes/No",
              "disease_name": "Specific Disease Name or No visible disease detected",
              "severity": "Healthy/Mild/Moderate/Severe",
              "disease_cause": "Detailed biological cause",
              "treatment": {
                "organic": "Specific organic methods",
                "chemical": "Fertilizer/Pesticide names",
                "prevention": "Preventive measures",
                "immediate_actions": "List of actions"
              },
              "care_tips": {
                "watering": "Schedule",
                "soil": "Requirements",
                "sunlight": "Exposure",
                "maintenance": "Upkeep"
              },
              "notes": "Explain why this growth stage was chosen and give specific expert diagnosis."
            }

            📊 VALIDATION CHECK:
            If image is NOT an agricultural plant/crop, return:
            { "error": "Invalid crop detection", "message": "This system matches 500+ agricultural species. Please upload a clear plant image.", "confidence": "0%" }
        \`;

        const openaiKey = process.env.OPENAI_API_KEY;
        const useOpenAI = openaiKey && openaiKey !== 'your-openai-api-key-here' && !openaiKey.startsWith('dummy');

        let photoData = null;

        if (useOpenAI) {
            try {
                console.log("🚀 Using OpenAI GPT-4o for High-Fidelity Analysis...");
                const oaiResult = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: \`data:\${mimeType};base64,\${imageBase64}\`
                                    }
                                }
                            ]
                        }
                    ],
                    max_tokens: 1000,
                    response_format: { type: "json_object" }
                });

                const content = oaiResult.choices[0].message.content;
                photoData = JSON.parse(content);
                console.log("✅ OpenAI Analysis Complete");
            } catch (oaiError) {
                console.warn("⚠️ OpenAI failed, falling back to Gemini:", oaiError.message);
            }
        }

        if (!photoData) {
            try {
                console.log("🔄 Using Gemini 1.5 Flash as fallback for image analysis...");
                const result = await genai.models.generateContent({
                    model: 'gemini-1.5-flash',
                    contents: [
                        prompt,
                        { inlineData: { mimeType: mimeType, data: imageBase64 } }
                    ]
                });

                const responseText = result.text?.trim() || "";
                let cleanText = responseText.replace(/\\x60\\x60\\x60json/g, '').replace(/\\x60\\x60\\x60/g, '').trim();
                const jsonMatch = cleanText.match(/\\{[\\s\\S]*\\}/);
                
                if (jsonMatch) {
                    photoData = JSON.parse(jsonMatch[0]);
                }
            } catch (genError) {
                console.error("Gemini image analysis failed:", genError.message);
            }
        }

        if (photoData && plantnetLabel) {
            const lowConfidence = !photoData.confidence || (photoData.crop_name && photoData.crop_name.toLowerCase().includes('low confidence'));
            if (lowConfidence) {
                photoData.crop_name = plantnetLabel.crop_name;
                photoData.scientific_name = plantnetLabel.scientific_name;
                photoData.confidence = plantnetLabel.confidence;
            }
        }

        if (photoData) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Could not delete uploaded file:', err);
            });
            return res.json({ success: true, photoData: photoData });
        } else {
            throw new Error('INVALID_AI_RESPONSE: AI could not analyze the image.');
        }
    } catch (e) {
        console.error('Gemini Analysis Failed:', e.message);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        // --- 🎯 THE FIX: Always return the dummy payload as requested! ---
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
                notes: "Returned fallback dummy response due to AI quota/error."
            } 
        });
    }
});

`;

    fs.writeFileSync('server.js', before + goodFunction + after);
    console.log("Successfully restored /api/upload-photo");
} else {
    console.log("Could not find insertion points");
}
