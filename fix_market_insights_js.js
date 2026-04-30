const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, 'public', 'dashboard.html');
let content = fs.readFileSync(targetFile, 'utf8');

// 1. Fix ReferenceError: t is not defined in updateMarketInsights function
const tDefinition = `            const lang = localStorage.getItem('lang') || 'en';
            const t = i18n[lang] || i18n.en;
            
            const marketSentimentText = document.getElementById('marketSentimentText');`;

content = content.replace(/const marketSentimentText = document\.getElementById\('marketSentimentText'\);/, tDefinition);

// 2. Fix the navigation issue (Ensure all sections are siblings of dashboardSection inside a container if needed)
// Actually, let's just make sure showSection works reliably.
// I'll add a console log to showSection to debug.

content = content.replace(/function showSection\(sectionId\) \{/, "function showSection(sectionId) {\n            console.log('Showing section:', sectionId);");

fs.writeFileSync(targetFile, content, 'utf8');
console.log("Fixed ReferenceError in updateMarketInsights and added debug logging.");
