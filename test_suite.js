/**
 * CropAI Simplified Test Suite
 */
require('dotenv').config();
const BASE_URL = 'http://127.0.0.1:3000';
let sessionCookie = '';
let passed = 0, failed = 0;
let skipped = 0;

async function req(method, path, body = null, withCookie = false) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (withCookie && sessionCookie) opts.headers['Cookie'] = sessionCookie;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, opts);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) sessionCookie = setCookie.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data };
}

function ok(label, detail) { passed++; console.log(`PASS: ${label} | ${detail}`); }
function ko(label, detail) { failed++; console.log(`FAIL: ${label} | ${detail}`); }
function skip(label, detail) { skipped++; console.log(`SKIP: ${label} | ${detail}`); }

async function run() {
    console.log('\n=== CropAI Test Suite ===');
    console.log('Time:', new Date().toLocaleString());

    // 1. Server
    try {
        const r = await req('GET', '/');
        r.status === 200 ? ok('GET /', `status=${r.status}`) : ko('GET /', `status=${r.status}`);
    } catch(e) { ko('GET /', e.message); }

    // 2. Login
    try {
        const r = await req('POST', '/api/login', { identifier: 'test@example.com', password: 'password123' });
        r.status === 200 && r.data?.user ? ok('Login', `user=${r.data.user.name}`) : ko('Login', `status=${r.status} data=${JSON.stringify(r.data)}`);
    } catch(e) { ko('Login', e.message); }

    // 3. Invalid login
    try {
        const r = await req('POST', '/api/login', { identifier: 'bad@test.com', password: 'wrong' });
        r.status === 401 ? ok('Login 401', 'blocked correctly') : ko('Login 401', `got ${r.status}`);
    } catch(e) { ko('Login 401', e.message); }

    // 4. Get user (authenticated)
    try {
        const r = await req('GET', '/api/user', null, true);
        r.status === 200 && r.data?.user ? ok('GET /api/user', `name=${r.data.user.name}`) : ko('GET /api/user', `status=${r.status}`);
    } catch(e) { ko('GET /api/user', e.message); }

    // 5. Soil analysis
    try {
        const r = await req('POST', '/api/soil-analysis', { n: 200, p: 35, k: 300, ph: 7.0, oc: 1.2, ec: 0.5 });
        r.status === 200 && r.data?.score ? ok('Soil analysis', `score=${r.data.score} status=${r.data.status}`) : ko('Soil analysis', `status=${r.status}`);
    } catch(e) { ko('Soil analysis', e.message); }

    // 6. Soil Tamil
    try {
        const r = await req('POST', '/api/soil-analysis', { n: 100, p: 25, k: 150, ph: 6.8, lang: 'ta' });
        const isTamil = r.data?.nutrients?.[0]?.label?.includes('தழைச்சத்து');
        r.status === 200 && isTamil ? ok('Soil Tamil', 'nutrients in Tamil') : ko('Soil Tamil', `status=${r.status} label=${r.data?.nutrients?.[0]?.label}`);
    } catch(e) { ko('Soil Tamil', e.message); }

    // 7. Crop recommendation
    try {
        const r = await req('POST', '/api/crop-recommendation', {
            n: 120,
            p: 30,
            k: 200,
            ph: 6.8,
            rainfall: 120,
            temperature: 27,
            humidity: 70,
            soilType: 'Loamy',
            climate: 'Tropical',
            season: 'Monsoon',
            waterAvailability: 'Medium',
            farmSize: 3
        });
        if (r.status === 200 && Array.isArray(r.data?.recommendations)) {
            ok('Crop Rec', `count=${r.data.recommendations.length} source=${r.data.source || 'AI'}`);
            r.data.recommendations.forEach(rec => console.log(`   > ${rec.crop}: ${rec.suitability} (${rec.suitabilityScore}%)`));
        } else { ko('Crop Rec', `status=${r.status} data=${JSON.stringify(r.data)?.slice(0,100)}`); }
    } catch(e) { ko('Crop Rec', e.message); }

    // 8. Chat (authenticated)
    try {
        const r = await req('POST', '/api/chat', { message: 'What is the best time to grow rice?', history: [] }, true);
        if (r.status === 200 && r.data?.reply) {
            ok('Chat AI', `fallback=${r.data.isFallback} reply="${r.data.reply.slice(0,60)}..."`);
        } else { ko('Chat AI', `status=${r.status}`); }
        } catch(e) { ko('Chat AI', e.message); }

    // 9. Climate
    try {
        const r = await req('GET', '/api/climate-data?lat=11.1&lng=77.3');
        r.status === 200 && r.data?.temperature ? ok('Climate', `temp=${r.data.temperature.toFixed(1)} humidity=${r.data.humidity.toFixed(1)}`) : ko('Climate', `status=${r.status}`);
    } catch(e) { ko('Climate', e.message); }

    // 10. Sensors
    try {
        const r = await req('GET', '/api/sensors');
        r.status === 200 && r.data?.temperature ? ok('Sensors', `temp=${r.data.temperature} pH=${r.data.pH}`) : ko('Sensors', `status=${r.status}`);
    } catch(e) { ko('Sensors', e.message); }

    // 11. Firebase config
    try {
        const r = await req('GET', '/api/config/firebase');
        r.status === 200 && r.data?.projectId ? ok('Firebase config', `projectId=${r.data.projectId}`) : ko('Firebase config', `status=${r.status}`);
    } catch(e) { ko('Firebase config', e.message); }

    // 12. Google config
    try {
        const r = await req('GET', '/api/config/google');
        r.status === 200 ? ok('Google config', `clientId present=${!!r.data?.clientId}`) : ko('Google config', `status=${r.status}`);
    } catch(e) { ko('Google config', e.message); }

    // 13. Gemini API direct test
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && !apiKey.startsWith('dummy') && apiKey !== 'your-gemini-api-key-here') {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say only: WORKING' }] }] })
            });
            const data = await res.json();
            if (res.status === 200) {
                ok('Gemini 2.0-flash', `reply="${data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()}"`);
            } else if (res.status === 429) {
                console.log('INFO: Gemini 2.0-flash quota exceeded, trying 1.5-flash...');
                const urlF = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
                const resF = await fetch(urlF, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say only: WORKING' }] }] }) });
                const dataF = await resF.json().catch(() => ({}));
                if (resF.status === 200) { 
                    ok('Gemini 1.5-flash(fallback)', 'working'); 
                } else if (resF.status === 429) {
                    console.log('INFO: Gemini 1.5-flash quota exceeded, trying 1.5-pro...');
                    const url2 = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`;
                    const res2 = await fetch(url2, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say only: WORKING' }] }] }) });
                    if (res2.status === 200) { ok('Gemini 1.5-pro(fallback)', 'working'); } 
                    else { ko('Gemini API', `all models quota exceeded`); }
                } else {
                    ko('Gemini API', `1.5-flash error status=${resF.status} msg=${dataF?.error?.message}`);
                }
            } else {
                ko('Gemini API', `status=${res.status} err=${data?.error?.message}`);
            }
        } catch(e) {
            const msg = String(e?.message || e);
            if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg)) {
                skip('Gemini API', 'unreachable in this environment');
            } else {
                ko('Gemini API', msg);
            }
        }
    } else {
        skip('Gemini API', 'API key not set');
    }

    // 14. Upload validation (no file)
    try {
        const r = await req('POST', '/api/upload-photo', {});
        (r.status === 400 || r.data?.status === 'failed') ? ok('Upload no-file', `correctly rejected`) : ko('Upload no-file', `status=${r.status}`);
    } catch(e) { ko('Upload no-file', e.message); }

    // 15. Logout
    try {
        const r = await req('GET', '/api/logout', null, true);
        r.status === 200 ? ok('Logout', 'success') : ko('Logout', `status=${r.status}`);
    } catch(e) { ko('Logout', e.message); }

    // 16. Unauthenticated check
    try {
        sessionCookie = '';
        const r = await req('GET', '/api/user');
        r.status === 401 ? ok('Unauth /api/user', '401 correct') : ko('Unauth /api/user', `got ${r.status}`);
    } catch(e) { ko('Unauth /api/user', e.message); }

    const total = passed + failed + skipped;
    console.log(`\n=== RESULTS: ${passed}/${total} passed, ${failed} failed, ${skipped} skipped ===\n`);
}

run().catch(e => console.error('Suite error:', e));
