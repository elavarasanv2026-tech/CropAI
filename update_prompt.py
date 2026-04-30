import re

with open('server.js', 'r', encoding='utf-8') as f:
    content = f.read()

pattern = r'const prompt = `.*?(Expert Agricultural Diagnosis Logic).*?If not a plant/crop, return:.*?\}`;'

replacement = '''const prompt = `
            You are an expert agricultural AI assistant.
            Analyze the uploaded crop image carefully and provide a detailed report in STRICT JSON format.
            The analysis must cover the following 8 areas:
            
            1. Crop Identification: Identify the crop name and scientific name.
            2. Crop Health Status: Determine whether the crop is healthy or unhealthy.
            3. Disease Detection: Detect visible diseases, pests, or deficiencies. Mention disease name, severity, and symptoms.
            4. Treatment & Solutions: Suggest organic and chemical treatments, pesticides, and immediate actions.
            5. Growth Stage Analysis: Identify the current growth stage and basic care tips.
            6. Monthly Crop Recommendations: Suggest 2-3 suitable alternative crops for the current/upcoming months for crop rotation.
            7. Expected Yield: Estimate the expected yield status or potential based on visual crop vigor.
            8. Soil Health Tips: Provide suggestions to improve soil health for this crop.
            
            RETURN STRICT JSON ONLY.
            {
                "crop_name": "...",
                "scientific_name": "...",
                "confidence": "...",
                "growth_stage": "...",
                "harvest_ready": true,
                "harvest_timing": "...",
                "harvest_guidance": "...",
                "disease_detected": "...",
                "disease_name": "...",
                "severity": "...",
                "disease_cause": "...",
                "treatment": {
                    "organic": "...",
                    "chemical": "...",
                    "prevention": "...",
                    "immediate_actions": "..."
                },
                "care_tips": { "watering": "...", "soil": "...", "sunlight": "...", "maintenance": "..." },
                "notes": "Detailed expert description and reasoning for this prediction.",
                "monthly_alternatives": ["...", "..."],
                "expected_yield": "...",
                "soil_health_tips": "..."
            }
            If not a plant/crop, return: { "error": "Invalid Detection", "message": "Agricultural domain restricted. Please upload crop photo." }`;'''

new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)
with open('server.js', 'w', encoding='utf-8') as f:
    f.write(new_content)
