const OpenAI = require('openai');
require('dotenv').config();

const testOpenAI = async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'dummy') {
        console.error('No valid OPENAI_API_KEY found');
        return;
    }

    const openai = new OpenAI({ apiKey });
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "Recommend 3 crops for clay soil in rainy season in India. Return JSON format." }],
            response_format: { type: "json_object" }
        });
        console.log('Success!', JSON.stringify(response.choices[0].message.content, null, 2));
    } catch (e) {
        console.error('OpenAI Error:', e.message);
    }
};

testOpenAI();
