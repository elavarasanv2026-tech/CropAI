require('dotenv').config();

async function testPerenual() {
    const key = process.env.PERENUAL_API_KEY;
    const crop = 'Rice';
    const url = `https://perenual.com/api/species-list?key=${key}&q=${crop}`;
    
    console.log(`Testing Perenual with crop: ${crop}`);
    try {
        const resp = await fetch(url);
        const data = await resp.json();
        console.log(JSON.stringify(data.data[0]?.default_image, null, 2));
    } catch (e) {
        console.error(e);
    }
}

testPerenual();
