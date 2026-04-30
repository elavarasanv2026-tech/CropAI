import re

with open('public/ml-analysis.js', 'r', encoding='utf-8') as f:
    content = f.read()

pattern = r'(?sm)\$\{analysis.monthly_alternatives && analysis.monthly_alternatives.length > 0 \? `.*?</div>\n                ` : \'\'\}'

replacement = '''${analysis.monthly_alternatives && analysis.monthly_alternatives.length > 0 ? `
                <div class=\"p-3 rounded-4 mb-4\" style=\"background: rgba(147, 51, 234, 0.07); border: 1px solid rgba(147, 51, 234, 0.15);\">
                    <h6 class=\"text-purple x-small fw-bold mb-3 text-uppercase text-center\" style=\"letter-spacing: 2.5px; color: #c084fc;\">
                        <i class=\"fas fa-calendar-alt me-2\"></i>Monthly Crop Alternatives
                    </h6>
                    <div class=\"d-flex flex-wrap justify-content-center gap-2\">
                        ${analysis.monthly_alternatives.map(alt => `<span class=\"badge\" style=\"background: rgba(192, 132, 252, 0.1); color: #e879f9; border: 1px solid rgba(192, 132, 252, 0.3); font-size: 0.8rem; padding: 6px 12px; border-radius: 8px;\">${alt}</span>`).join('')}
                    </div>
                </div>
                ` : ''}

                ${analysis.expected_yield ? `
                <div class=\"p-3 rounded-4 mb-4\" style=\"background: rgba(0, 255, 136, 0.05); border: 1px solid rgba(0, 255, 136, 0.1);\">
                    <h6 class=\"text-success x-small fw-bold mb-3 text-uppercase text-center\" style=\"letter-spacing: 2.5px; color: #00ff88;\">
                        <i class=\"fas fa-chart-line me-2\"></i>Expected Yield
                    </h6>
                    <p class=\"x-small text-white-75 mb-0 text-center\" style=\"line-height: 1.6;\">${analysis.expected_yield}</p>
                </div>
                ` : ''}

                ${analysis.soil_health_tips ? `
                <div class=\"p-3 rounded-4 mb-4\" style=\"background: rgba(255, 153, 0, 0.05); border: 1px solid rgba(255, 153, 0, 0.1);\">
                    <h6 class=\"text-warning x-small fw-bold mb-3 text-uppercase text-center\" style=\"letter-spacing: 2.5px; color: #ff9900;\">
                        <i class=\"fas fa-leaf me-2\"></i>Soil Health Tips
                    </h6>
                    <p class=\"x-small text-white-75 mb-0 text-center\" style=\"line-height: 1.6;\">${analysis.soil_health_tips}</p>
                </div>
                ` : ''}'''

new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)
with open('public/ml-analysis.js', 'w', encoding='utf-8') as f:
    f.write(new_content)
