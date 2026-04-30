const fetch = require('node-fetch');
require('dotenv').config();

const listModels = async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log('Using Key:', apiKey);
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.models) {
            console.log('Available Models:');
            data.models.forEach(m => {
                if (m.supportedGenerationMethods.includes('generateContent')) {
                    console.log('  -', m.name);
                }
            });
        } else {
            console.log('No models found or error:', JSON.stringify(data, null, 2));
        }
    } catch (e) {
        console.error(e);
    }
};

listModels();
