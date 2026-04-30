const { GoogleGenAI } = require("@google/genai");
const genai = new GoogleGenAI({ apiKey: "AIzaSyB6szkUnDRr_t_hvSWGd-Et5Q5jGBegxTw" });
async function test() {
    try {
        const result = await genai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: "Hi"
        });
        console.log("Success:", result.text);
    } catch (e) {
        console.log("Error Name:", e.name);
        console.log("Error Message:", e.message);
        console.log("Error Stack:", e.stack);
    }
}
test();
