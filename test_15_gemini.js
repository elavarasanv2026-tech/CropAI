const { GoogleGenAI } = require("@google/genai");
require("dotenv").config();
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
genai.models.generateContent({ 
  model: "gemini-1.5-flash", 
  contents: [{role: "user", parts: [{text: "Hi"}]}] 
}).then(r => console.log("SUCCESS:", r.text)).catch(e => console.error("ERROR:", e.message));
