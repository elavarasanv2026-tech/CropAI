require('dotenv').config();

const apiKey = String(process.env.PLANT_ID_API_KEY || '').trim();
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function testPlantId() {
  if (!apiKey) {
    throw new Error('PLANT_ID_API_KEY is missing in the environment.');
  }

  try {
    const res = await fetch(`https://plant.id/api/v3/identification?details=common_names,disease_details`, {
      method: 'POST',
      headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: [imageBase64], similar_images: true })
    });
    console.log("V3 Identification Status:", res.status);
    console.log(await res.text());
  } catch (e) { console.error('v3 fail:', e); }

  try {
    const res = await fetch(`https://plant.id/api/v3/health_assessment?details=disease_details,treatment`, {
      method: 'POST',
      headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: [imageBase64] })
    });
    console.log("V3 Health Status:", res.status);
    console.log(await res.text());
  } catch (e) { console.error('v3 health fail:', e); }

  try {
    const res = await fetch(`https://api.plant.id/v2/identify`, {
      method: 'POST',
      headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: [imageBase64], plant_details: ['common_names'] })
    });
    console.log("V2 Identify Status:", res.status);
    console.log(await res.text());
  } catch (e) { console.error('v2 identify fail:', e); }
}

testPlantId();
