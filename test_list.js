const { GoogleGenAI } = require("@google/genai");
require("dotenv").config();
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function test() {
    try {
        const response = await genai.models.list();
        for await (const model of response) {
            console.log(model.name);
        }
    } catch (e) {
        console.error("ERROR:", e.message);
    }
}
test();
