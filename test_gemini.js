const fetch = require('node-fetch');
require('dotenv').config();

const testGemini = async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log('Testing Gemini API with key:', apiKey);
    
    if (!apiKey || apiKey === 'your-gemini-api-key-here') {
        console.error('No valid GEMINI_API_KEY found in .env');
        return;
    }

    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const prompt = "Recommend 3 crops for clay soil in rainy season in India. Return JSON format.";
    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents })
        });

        console.log('Response Status:', response.status);
        const data = await response.json();
        
        if (response.ok) {
            console.log('Success! Response:');
            console.log(JSON.stringify(data, null, 2));
        } else {
            console.error('Error Response:');
            console.log(JSON.stringify(data, null, 2));
        }
    } catch (e) {
        console.error('Fetch Error:', e.message);
    }
};

testGemini();
