const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");
require("dotenv").config();

const genai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function test() {
    console.log("Testing OpenAI...");
    try {
        const oaiRes = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{role: "user", content: "Hello"}],
            max_tokens: 5
        });
        console.log("OpenAI success:", oaiRes.choices[0].message.content);
    } catch (e) {
        console.error("OpenAI Error:", e.message);
    }

    console.log("\nTesting Gemini...");
    try {
        // Test models.generateContent (the syntax that was used before)
        const gemRes = await genai.models.generateContent({
             model: "gemini-1.5-flash",
             contents: [{role: "user", parts: [{text: "Hello"}]}]
        });
        console.log("Gemini models.generateContent success:", gemRes.text);
    } catch (e) {
        console.error("Gemini models.generateContent Error:", e.message);
        try {
            console.log("Attempting getGenerativeModel syntax...");
            const model = genai.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent("Hello");
            const response = await result.response;
            console.log("Gemini getGenerativeModel success:", response.text());
        } catch (e2) {
            console.error("Gemini getGenerativeModel Error:", e2.message);
        }
    }
}

test();
