const fetch = require('node-fetch');
const fs = require('fs');
require('dotenv').config();

const listModels = async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        let models = data.models ? data.models.map(m => m.name).join('\n') : JSON.stringify(data);
        fs.writeFileSync('available_models.txt', models);
    } catch (e) {
        fs.writeFileSync('available_models.txt', e.message);
    }
};

listModels();
