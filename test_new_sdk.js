const { GoogleGenAI } = require("@google/genai");
const genai = new GoogleGenAI({ apiKey: "AIzaSyB6szkUnDRr_t_hvSWGd-Et5Q5jGBegxTw" });
async function run() {
    try {
        const response = await genai.models.generateContent({ model: "gemini-2.0-flash", contents: "hi" });
        console.log("TEXT:", response.text);
    } catch(e) {
        console.log("ERROR:", e.message);
    }
}
run();
