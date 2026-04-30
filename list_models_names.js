const fetch = require('node-fetch');
require('dotenv').config();

const listModels = async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.models) {
            data.models.forEach(m => console.log(m.name));
        } else {
            console.log('No models found or error:', data);
        }
    } catch (e) {
        console.error(e);
    }
};

listModels();
