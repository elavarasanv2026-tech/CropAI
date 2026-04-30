require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const getGeminiResponse = async (prompt, history = [], isChat = true, image = null) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your-gemini-api-key-here' || apiKey.startsWith('dummy')) return null;
    
    // Advanced: Try increasingly capable professional models if quota is exhausted
    const models = isChat ? ['gemini-2.0-flash', 'gemini-1.5-pro'] : ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'];
    
    for (const model of models) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 18000); // 18s deep-analysis timeout
        
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const contents = isChat ? [...history, { role: 'user', parts: [{ text: prompt }] }] : [{ 
                role: 'user',
                parts: [
                    { text: "ADVANCED AGRICULTURAL NLP LOGIC: Utilize high-precision linguistic reasoning to analyze this image. " + prompt }, 
                    ...(image ? [{ inline_data: { mime_type: image.mimeType, data: image.base64 } }] : [])
                ] 
            }];
            
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents, generationConfig: !isChat ? { response_mime_type: "application/json" } : {} }),
                signal: controller.signal
            });
            clearTimeout(timeout);
            
            if (response.status === 429) {
                console.warn(`[WARN] Quota Exceeded on ${model}. Escalating to premium fallback...`);
                continue;
            }
            
            if (!response.ok) {
                console.warn(`[WARN] Model ${model} failed with ${response.status}. Trying next...`);
                continue;
            }
            
            const data = await response.json();
            return data.candidates?.[0]?.content?.parts?.[0]?.text;
        } catch (e) { 
            clearTimeout(timeout);
            console.error(`[ERROR] Server analysis error on ${model}:`, e.message);
        }
    }
    return null; 
};

async function test() {
    const prompt = `Based on these parameters: N=10, P=20, K=30, pH=6.5, Rainfall=100mm, Temp=25C, Humidity=60%. 
        Recommend the top 3 best crops for a farmer in India. 
        Return ONLY valid JSON: { "source": "AI-Generated", "recommendations": [ { "crop": "...", "suitability": "High/Medium/Low", "suitabilityScore": 0-100, "description": "...", "yieldPerAcre": 0, "unit": "tons/q" } ] }`;

    const reply = await getGeminiResponse(prompt, [], false);
    console.log("REPLY =====\n", reply);
}

test();
