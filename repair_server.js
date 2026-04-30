const fs = require('fs');

const content = fs.readFileSync('c:/Users/elava/Documents/Project/Project/CropAI/server.js', 'utf8');

const startMarker = "app.get('/api/disease-image-search'";
const endMarker = "app.use((err, req, res, next) => {";

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error('Could not find markers', { startIndex, endIndex });
    process.exit(1);
}

const head = content.substring(0, startIndex);
const tail = content.substring(endIndex);

const middle = `app.get('/api/disease-image-search', (req, res) => {
    const { crop, name } = req.query;
    if (!name) return res.status(400).json({ error: 'Disease name is required' });
    
    const crp = (crop || '').toLowerCase();
    
    const library = {
        'rice blast': '/images/diseases/blast_disease.png',
        'rice sheath rot': '/images/diseases/sheath_rot.png',
        'tomato early blight': '/images/diseases/early_blight.png',
        'potato early blight': '/images/diseases/early_blight.png',
        'tomato fusarium wilt': '/images/diseases/fusarium_wilt.png',
        'chickpea fusarium wilt': '/images/diseases/chickpea_fusarium_wilt.png',
        'chickpea ascochyta blight': '/images/diseases/chickpea_ascochyta_blight.png',
        'chickpea collar rot': '/images/diseases/chickpea_collar_rot.png',
        'cotton bacterial blight': '/images/diseases/bacterial_blight.png',
        'cotton root rot': '/images/diseases/cotton_root_rot.png',
        'wheat rust': '/images/diseases/wheat_rust.png',
        'wheat loose smut': '/images/diseases/loose_smut.png',
        'maize smut': '/images/diseases/maize_smut.png',
        'maize leaf blight': '/images/diseases/maize_leaf_blight.png',
        'maize stalk rot': '/images/diseases/maize_stalk_rot.png',
        'sunflower alternaria leaf spot': '/images/diseases/sunflower_alternaria_leaf_spot.png',
        'sunflower stem rot': '/images/diseases/sunflower_stem_rot.png',
        'sugarcane red rot': '/images/diseases/sugarcane_red_rot.png',
        'sugarcane smut': '/images/diseases/sugarcane_smut.png',
        'rice udbatta': '/images/diseases/udbatta_disease.png',
        'soybean rust': '/images/diseases/soybean_rust.png',
        'groundnut leaf spot': '/images/diseases/leaf_spot.png',
        'chili anthracnose': '/images/diseases/anthracnose.png',
        'onion purple blotch': '/images/diseases/purple_blotch.png',
        'black gram yellow mosaic virus': '/images/diseases/gram_yellow_mosaic_virus.png',
        'black gram powdery mildew': '/images/diseases/gram_powdery_mildew.png',
        'green gram yellow mosaic virus': '/images/diseases/gram_yellow_mosaic_virus.png',
        'green gram cercospora leaf spot': '/images/diseases/gram_cercospora_leaf_spot.png'
    };

    const key = \`\${crp} \${name}\`.trim();
    let url = library[key];
    
    if (!url) {
        // Fallback to name search
        const found = Object.keys(library).find(k => k.includes(name.toLowerCase()));
        if (found) url = library[found];
    }

    res.json({ url: url || '/images/diseases/leaf_spot.png', source: 'Internal Database' });
});

app.get('/api/disease-care', (req, res) => {
    const { crop, lang = 'en' } = req.query;
    const isTa = lang === 'ta';
    
    const cropData = {
        'Rice/Paddy': {
            prevention: [
                isTa ? 'சான்றிதழ் பெற்ற நோய் தாக்காத விதைகளைப் பயன்படுத்தவும்.' : 'Use certified disease-free seeds.',
                isTa ? 'வயலை சுத்தமாக வைத்திருந்து முந்தைய பயிர் எச்சங்களை அகற்றவும்.' : 'Keep the field clean and remove previous crop residues.',
                isTa ? 'தழைச்சத்தை (Nitrogen) பிரித்து இடவும்.' : 'Apply nitrogenous fertilizers in split doses.',
                isTa ? 'வயலில் சீரான அளவில் நீரை நிறுத்தவும்.' : 'Maintain a thin film of water in the field.'
            ],
            treatment: [
                isTa ? 'குமிழி நோய்க்கு (Blast) ட்ரைசைக்ளோசோல் தெளிக்கவும்.' : 'Spray Tricyclazole for Blast disease.',
                isTa ? 'சரியான உர மேலாண்மை மூலம் எதிர்ப்புத் திறனை அதிகரிக்கவும்.' : 'Increase resistance through balanced fertilizer management.',
                isTa ? 'உறையழுகல் நோய்க்கு (Sheath rot) கார்பெண்டாசிம் பயன்படுத்தவும்.' : 'Apply Carbendazim for Sheath rot.'
            ],
            careTips: [
                isTa ? 'நடவு செய்த முதல் வாரத்தில் 2-3 செ.மீ நீரை பராமரிக்கவும்.' : 'Maintain 2-3 cm water level during the first week after transplanting.',
                isTa ? 'வாரம் ஒருமுறை பயிர் வளர்ச்சியை கண்காணிக்கவும்.' : 'Monitor crop growth once a week.',
                isTa ? 'பயிருக்கு கயிறு தேய்த்து இலைத் தேய்ப்பு பூச்சிகளைக் கட்டுப்படுத்தலாம்.' : 'Use a rope to disturb and control leaf folders.'
            ],
            harvestingTips: [
                isTa ? 'தானியங்கள் 80-85% முதிர்ந்தவுடன் அறுவடை செய்யவும்.' : 'Harvest when 80-85% of the grains are mature.',
                isTa ? 'காலை நேரங்களில் அறுவடை செய்வதைத் தவிர்க்கவும்.' : 'Avoid harvesting during morning hours with dew.'
            ],
            sustainablePractices: [
                isTa ? 'பசுந்தாள் உரங்களைப் பயன்படுத்தவும்.' : 'Use green manure crops.',
                isTa ? 'வேப்பம் புண்ணாக்கை உரமாக இடுங்கள்.' : 'Apply neem cake as fertilizer.'
            ],
            irrigationStrategies: [
                isTa ? 'மாற்று ஈர மற்றும் உலர் நீர்ப்பாசன முறையை (AWD) பின்பற்றவும்.' : 'Follow Alternate Wetting and Drying (AWD) method.',
                isTa ? 'நீரை வீணாக்காமல் குழாய்கள் மூலம் பாய்ச்சவும்.' : 'Use pipes to carry water without wastage.'
            ],
            agriculturalInputs: [
                isTa ? 'யூரியா' : 'Urea',
                isTa ? 'டி.ஏ.பி' : 'DAP',
                isTa ? 'பொட்டாஷ்' : 'Potash',
                isTa ? 'நுண்ணூட்டச்சத்து கலவை' : 'Micronutrient Mixture'
            ],
            diseases: [
                { name: isTa ? 'குமிழி நோய் (Blast)' : 'Rice Blast', symptoms: isTa ? 'இலைகளில் கண் வடிவப் புள்ளிகள் தோன்றும்.' : 'Eye-shaped spots appear on leaves.' },
                { name: isTa ? 'உறையழுகல் நோய் (Sheath Rot)' : 'Sheath Rot', symptoms: isTa ? 'மேல் இலை உரைகளில் பழுப்பு நிறப் புள்ளிகள்.' : 'Brownish spots on upper leaf sheaths.' },
                { name: isTa ? 'உத்பாட்டா நோய்' : 'Udbatta Disease', symptoms: isTa ? 'கதிர்கள் ஊசி போன்ற வடிவத்தில் மாறும்.' : 'Panicles transformed into needle-like structures.' }
            ]
        },
        'Wheat': {
            prevention: [
                isTa ? 'முன்கூட்டியே விதைப்பதைத் தவிர்க்கவும்.' : 'Avoid early sowing to prevent rust.',
                isTa ? 'நோய் எதிர்ப்புத் திறன் கொண்ட ரகங்களைத் தேர்ந்தெடுக்கவும்.' : 'Select rust-resistant varieties.',
                isTa ? 'விதை நேர்த்தி செய்ய கார்பாக்சின் பயன்படுத்தவும்.' : 'Use Carboxin for seed treatment.'
            ],
            treatment: [
                isTa ? 'துரு நோய்க்கு (Rust) புரோபிகோனசோல் தெளிக்கவும்.' : 'Spray Propiconazole for Rust disease.',
                isTa ? 'கரிப்பூட்டை நோய்க்கு (Smut) முறையான விதை நேர்த்தியே தீர்வு.' : 'Proper seed treatment is the key for Smut.'
            ],
            careTips: [
                isTa ? 'முக்கியமான வளர்ச்சி நிலைகளில் நீர்ப்பாசனம் செய்யவும்.' : 'Irrigate during critical growth stages (e.g. CRI).',
                isTa ? 'களைகளைக் கட்டுப்படுத்துவது மகசூலுக்கு முக்கியம்.' : 'Weed management is crucial for yield.'
            ],
            harvestingTips: [
                isTa ? 'தானியங்கள் கடினமான பிறகு அறுவடை செய்யவும்.' : 'Harvest when grains are hard and dry.',
                isTa ? 'அறுவடைக்கு பின் மட்கும் இயந்திரங்களைப் பயன்படுத்தவும்.' : 'Use threshing machines after harvest.'
            ],
            sustainablePractices: [
                isTa ? 'பயிர் சுழற்சி முறையைப் பின்பற்றவும்.' : 'Follow crop rotation practices.',
                isTa ? 'மண் வளத்தைப் பாதுகாக்க தழை உரமிடுதல்.' : 'Mulching to preserve soil moisture.'
            ],
            irrigationStrategies: [
                isTa ? 'தெளிப்பு நீர்ப்பாசனம் சிறந்தது.' : 'Sprinkler irrigation is effective.',
                isTa ? 'வேர் பகுதிகளில் ஈரம் இருப்பதை உறுதி செய்யவும்.' : 'Ensure moisture at the root zone.'
            ],
            agriculturalInputs: [
                isTa ? 'N-P-K கலவை' : 'N-P-K Fertilizer',
                isTa ? 'துத்தநாக சல்பேட்' : 'Zinc Sulphate',
                isTa ? 'ஜிப்சம்' : 'Gypsum'
            ],
            diseases: [
                { name: isTa ? 'கோதுமை துரு நோய்' : 'Wheat Rust', symptoms: isTa ? 'இலைகளில் ஆரஞ்சு அல்லது கருப்பு பொட்டுக்கள்.' : 'Orange or black pustules on leaves.' },
                { name: isTa ? 'கரிப்பூட்டை நோய்' : 'Loose Smut', symptoms: isTa ? 'கதிர்களில் கருப்பு நிறத் தூள்கள் தோன்றும்.' : 'Black powdery mass on panicles.' }
            ]
        },
        'Tomato': {
            prevention: [
                isTa ? 'வயலில் தண்ணீர் தேங்குவதைத் தவிர்க்கவும்.' : 'Avoid waterlogging in the field.',
                isTa ? 'நடும் முன் வேர் முனைகளில் பூஞ்சான் கொல்லி நேர்த்தி.' : 'Root dip treatment before transplanting.'
            ],
            treatment: [
                isTa ? 'வாடல் நோய்க்கு காப்பர் ஆக்ஸிகுளோரைடு பயன்படுத்தவும்.' : 'Apply Copper Oxychloride for wilt diseases.',
                isTa ? 'இலைத் தேமல் நோய்க்கு வேம்பு எண்ணெய் தெளிக்கவும்.' : 'Spray Neem oil for leaf curl virus vector control.'
            ],
            careTips: [
                 isTa ? 'செடிகளுக்கு முட்டுக்கொடுத்து நேராக வளர்க்கவும்.' : 'Provide staking support for vertical growth.',
                 isTa ? 'அடிப்பகுதி இலைகளை அகற்றி காற்றோட்டத்தை அதிகரிக்கவும்.' : 'Prune lower leaves to increase aeration.'
            ],
            harvestingTips: [
                isTa ? 'தூரம் கொண்டு செல்ல வேண்டிய பழங்களை முதிர்ந்த பச்சை நிலையில் பறிக்கவும்.' : 'Harvest at mature green stage for long-distance transport.',
                isTa ? 'உள்ளூர் சந்தைக்கு எனில் முழு சிவந்த நிலையில் பறிக்கவும்.' : 'Harvest at fully ripe stage for local markets.'
            ],
            sustainablePractices: [
                 isTa ? 'பூச்சி விரட்ட சாமந்தி செடிகளை ஊடுபயிராக நடவும்.' : 'Intercrop with Marigold to repel pests.',
                 isTa ? 'கரிமக் கம்போஸ்ட் அதிகளவில் பயன்படுத்தவும்.' : 'Use organic compost generously.'
            ],
            irrigationStrategies: [
                 isTa ? 'சொட்டு நீர்ப்பாசனம் (Drip) மூலம் நோய் பரவலைக் குறைக்கலாம்.' : 'Drip irrigation reduces disease spread.',
                 isTa ? 'மாலையி்ல் நீர்ப்பாய்ச்சுவதைத் தவிர்க்கவும்.' : 'Avoid late evening irrigation.'
            ],
            agriculturalInputs: [
                isTa ? 'வெர்மிகம்போஸ்ட்' : 'Vermicompost',
                isTa ? 'வேப்பம் புண்ணாக்கு' : 'Neem Cake',
                isTa ? 'கால்சியம் நைட்ரேட்' : 'Calcium Nitrate'
            ],
            diseases: [
                { name: isTa ? 'ஆரம்பகால கருகல்' : 'Early Blight', symptoms: isTa ? 'கீழ் இலைகளில் பழுப்பு நிற வளையங்கள்.' : 'Concentric brown rings on lower leaves.' },
                { name: isTa ? 'பியூசேரியம் வாடல்' : 'Fusarium Wilt', symptoms: isTa ? 'செடி முழுவதும் வாடி காய்ந்துவிடும்.' : 'Rapid yellowing and wilting of the whole plant.' }
            ]
        },
        'Maize/Corn': {
            prevention: [
                isTa ? 'விதைகளைத் தேர்ந்தெடுத்து விதை நேர்த்தி செய்யவும்.' : 'Treat seeds with fungicides before sowing.',
                isTa ? 'முறையான பயிர் சுழற்சி முறையைப் பின்பற்றவும்.' : 'Implement proper crop rotation.',
                isTa ? 'வயலைச் சுற்றியுள்ள களைகளை அகற்றவும்.' : 'Remove weeds around the field boundaries.'
            ],
            treatment: [
                isTa ? 'இலைக்கருகல் நோய்க்கு மேன்கோசெப் தெளிக்கவும்.' : 'Spray Mancozeb for leaf blight.',
                isTa ? 'தண்டு அழுகல் நோய்க்கு முறையான வடிகால் வசதி தேவை.' : 'Ensure proper drainage for stalk rot management.'
            ],
            careTips: [
                isTa ? 'பூக்கும் பருவத்தில் நீர் பற்றாக்குறை இல்லாமல் பார்த்துக்கொள்ளவும்.' : 'Avoid water stress during the flowering stage.',
                isTa ? 'மண்ணில் போதிய அளவு தழைச்சத்து இருப்பதை உறுதி செய்யவும்.' : 'Ensure adequate nitrogen levels in the soil.'
            ],
            harvestingTips: [
                isTa ? 'கதிர்கள் நன்கு காய்ந்த பிறகு அறுவடை செய்யவும்.' : 'Harvest when the husks are dry and grains are hard.',
                isTa ? 'தானியங்களில் ஈரப்பதம் 12-14% இருக்குமாறு காயவைக்கவும்.' : 'Dry the grains to 12-14% moisture content.'
            ],
            sustainablePractices: [
                isTa ? 'இயற்கை உரங்களை அதிகளவில் பயன்படுத்தவும்.' : 'Use organic fertilizers extensively.',
                isTa ? 'உயிரி பூச்சிக்கொல்லிகளை முன்னுரிமை அளிக்கவும்.' : 'Prioritize the use of bio-pesticides.'
            ],
            irrigationStrategies: [
                isTa ? 'வயலில் தண்ணீர் தேங்குவதைத் தவிர்க்கவும்.' : 'Prevent waterlogging in the maize field.',
                isTa ? 'முக்கிய வளர்ச்சி நிலைகளில் தவறாமல் நீர்ப்பாசனம் செய்யவும்.' : 'Irrigate regularly during critical growth stages.'
            ],
            agriculturalInputs: [
                isTa ? 'யூரியா' : 'Urea',
                isTa ? 'சூப்பர் பாஸ்பேட்' : 'Single Super Phosphate (SSP)',
                isTa ? 'துத்தநாக சல்பேட்' : 'Zinc Sulphate'
            ],
            diseases: [
                { name: isTa ? 'சோள இலைக்கருகல்' : 'Maize Leaf Blight', symptoms: isTa ? 'இலைகளில் நீண்ட பழுப்பு நிறப் புள்ளிகள்.' : 'Long, elliptical, grayish-green or tan lesions on leaves.' },
                { name: isTa ? 'சோளக் கரிப்பூட்டை' : 'Maize Smut', symptoms: isTa ? 'கதிர்களில் வெள்ளை நிறப் பைகள் தோன்றி கருப்பாக மாறும்.' : 'White galls on ears that turn into black powdery mass.' }
            ]
        },
        'Sugarcane': {
             prevention: [
                isTa ? 'நோய் தாக்காத கரணைகளைத் தேர்ந்தெடுக்கவும்.' : 'Select disease-free setts for planting.',
                isTa ? 'கரணைகளை நடும் முன் சுடு நீர் நேர்த்தி செய்யவும்.' : 'Treat setts with hot water before planting.'
            ],
            treatment: [
                isTa ? 'செவ்வழுகல் நோயைக் கட்டுப்படுத்த கார்பெண்டாசிம் பயன்படுத்தவும்.' : 'Use Carbendazim for red rot management.',
                isTa ? 'பாதிக்கப்பட்ட தூர்களை உடனே அகற்றி எரிக்கவும்.' : 'Remove and burn infected clumps immediately.'
            ],
            careTips: [
                 isTa ? 'பயிர்களுக்கு மண் அணைத்தல் (Earthing up) வேலையைச் செய்யவும்.' : 'Perform timely earthing up operations.',
                 isTa ? 'சோகை உரித்தல் மூலம் பூச்சித் தாக்குதலைக் குறைக்கலாம்.' : 'Detach old leaves (detrashing) to reduce pest hiding spots.'
            ],
            harvestingTips: [
                isTa ? 'சர்க்கரை அளவு உச்சத்தில் இருக்கும்போது அறுவடை செய்யவும்.' : 'Harvest when sugar content (Brix) is at its peak.',
                isTa ? 'அறுவடை செய்தவுடன் ஆலைக்கு அனுப்பவும்.' : 'Transport to the factory immediately after harvest.'
            ],
            sustainablePractices: [
                 isTa ? 'தோகைகளை எரிக்காமல் மண்ணில் மட்கச் செய்யவும்.' : 'Trash mulching instead of burning crop residues.',
                 isTa ? 'ஊடுபயிராக பயறு வகைகளை விளைவிக்கவும்.' : 'Grow legumes as an intercrop.'
            ],
            irrigationStrategies: [
                 isTa ? 'கரும்புக்கு சொட்டு நீர்ப்பாசனம் மேலானது.' : 'Drip irrigation is highly efficient for sugarcane.',
                 isTa ? 'வறட்சி காலங்களில் நீண்ட இடைவெளியைத் தவிர்க்கவும்.' : 'Avoid long irrigation intervals during summer.'
            ],
            agriculturalInputs: [
                isTa ? 'தொழு உரம்' : 'Farm Yard Manure (FYM)',
                isTa ? 'திரவ பயோ உரங்கள்' : 'Liquid Bio-fertilizers',
                isTa ? 'நுண்ணூட்டச்சத்து கலவை' : 'Micronutrient Mixture'
            ],
            diseases: [
                { name: isTa ? 'செவ்வழுகல் நோய்' : 'Red Rot', symptoms: isTa ? 'தண்டின் உள்ளே சிவப்பு நிறக் கோடுகள்.' : 'Reddish lesions and acidic smell inside the stalk.' },
                { name: isTa ? 'கரும்பு கரிப்பூட்டை' : 'Sugarcane Smut', symptoms: isTa ? 'உச்சிக் குருத்தில் இருந்து கசையடித்தது போன்ற கருப்புத் தண்டு.' : 'Whip-like black structure from the shoot apex.' }
            ]
        },
        'Cotton': {
            prevention: [
                isTa ? 'சான்றிதழ் பெற்ற விதைகளை மட்டும் பயன்படுத்தவும்.' : 'Use only certified and treated seeds.',
                isTa ? 'பருத்திக்கு பின் அதே இனம் அல்லாத பயிரைப் பயிரிடவும்.' : 'Follow crop rotation with non-host crops.'
            ],
            treatment: [
                isTa ? 'பாக்டீரியல் வாடல் நோய்க்கு ஸ்டரெப்டோமைசின் பயன்படுத்தவும்.' : 'Use Streptokinase/Streptomycin for bacterial blight.',
                isTa ? 'வேர் அழுகல் நோய்க்கு டிரைக்கோடெர்மா விரிடி பயன்படுத்தவும்.' : 'Apply Trichoderma viride for root rot control.'
            ],
            careTips: [
                 isTa ? 'முனைக் கிள்ளுதல் மூலம் பக்கக் கிளைகளை அதிகரிக்கலாம்.' : 'Perform topping to encourage lateral branching.',
                 isTa ? 'களைகளைக் கட்டுப்படுத்துவது பருத்திக்கு மிகவும் அவசியம்.' : 'Manual weeding is essential for healthy cotton growth.'
            ],
            harvestingTips: [
                isTa ? 'வெடித்த பருத்திக் காய்களை காலை நேரத்தில் பறிக்கவும்.' : 'Pick matured bolls during early morning to avoid trash.',
                isTa ? 'தூய்மையான பருத்தியை மட்டும் தனியாகச் சேகரிக்கவும்.' : 'Store clean cotton separately from stained one.'
            ],
            sustainablePractices: [
                 isTa ? 'பூச்சிகளைக் கவர இனக்கவர்ச்சிப் பொறிகளைப் பயன்படுத்தவும்.' : 'Install pheromone traps for pest monitoring.',
                 isTa ? 'வேப்பம் எண்ணெயைத் தெளிக்கவும்.' : 'Use neem-based sprays as repellent.'
            ],
            irrigationStrategies: [
                 isTa ? 'பூக்கும் மற்றும் காய் பிடிக்கும் பருவத்தில் அதிக நீர் தேவை.' : 'High water demand during flowering and boll formation.',
                 isTa ? 'வாய்க்கால் பாசனத்தை விட சொட்டு நீர் பாசனம் சிறந்தது.' : 'Drip irrigation is preferred over furrow irrigation.'
            ],
            agriculturalInputs: [
                isTa ? 'நுண்ணூட்டச்சத்து மாத்திரைகள்' : 'Micronutrient Pellets',
                isTa ? 'இயற்கை பூச்சி விரட்டிகள்' : 'Bio-pesticides',
                isTa ? 'திரவ உரம்' : 'Liquid Fertilizer'
            ],
            diseases: [
                { name: isTa ? 'பாக்டீரியா கருகல்' : 'Bacterial Blight', symptoms: isTa ? 'இலைகளில் முக்கோண வடிவ பழுப்புப் புள்ளிகள்.' : 'Angular water-soaked lesions on leaves and bolls.' },
                { name: isTa ? 'வேர் அழுகல் நோய்' : 'Root Rot', symptoms: isTa ? 'செடிகள் திடீரென வாடி காய்ந்துவிடும்.' : 'Sudden wilting and death of plants, roots turn dark.' }
            ]
        },
        'Potato': {
            prevention: [
                isTa ? 'நோய் தாக்காத விதைக் கிழங்குகளைப் பயன்படுத்தவும்.' : 'Use certified disease-free seed tubers.',
                isTa ? 'கிழங்குகளை நடும் முன் பூஞ்சான் கொல்லி நேர்த்தி.' : 'Treat tubers with fungicides before planting.'
            ],
            treatment: [
                isTa ? 'பிந்தைய கருகல் நோய்க்கு மெட்டாலாக்ஸில் தெளிக்கவும்.' : 'Spray Metalaxyl for late blight control.',
                isTa ? 'முறையான பயிர் இடைவெளி மூலம் நோய் பரவலைத் தவிர்க்கவும்.' : 'Maintain proper spacing to reduce humidity around plants.'
            ],
            careTips: [
                 isTa ? 'முறையாக மண் அணைத்தல் (Earthing up) செய்ய வேண்டும்.' : 'Timely earthing up is crucial for tuber development.',
                 isTa ? 'செப்புகளுக்கு நைட்ரஜன் உரத்தை பிரித்து இடவும்.' : 'Apply nitrogen in split doses.'
            ],
            harvestingTips: [
                isTa ? 'அறுவடைக்கு முன் செடிகளின் மேல் பாகத்தை அகற்றி (Dehaulming) 10 நாட்கள் கழித்து அறுவடை செய்யவும்.' : 'Perform dehaulming 10-14 days before harvesting.',
                isTa ? 'கிழங்குகளில் சிராய்ப்பு ஏற்படாமல் கவனமாகத் தோண்டவும்.' : 'Avoid mechanical damage to tubers during digging.'
            ],
            sustainablePractices: [
                 isTa ? 'உயிரி பூஞ்சான் கொல்லிகளைப் பயன்படுத்தவும்.' : 'Incorporate bio-fungicides like Trichoderma.',
                 isTa ? 'நிழலான இடங்களில் கிழங்குகளைச் சேமிக்கவும்.' : 'Store tubers in cool, dark ventilated places.'
            ],
            irrigationStrategies: [
                 isTa ? 'கிழங்கு உருவாகும் போது சமமான ஈரம் தேவை.' : 'Maintain uniform moisture during tuber initiation.',
                 isTa ? 'மாலையி்ல் நீர் பாய்ச்சுவதைத் தவிர்க்கவும்.' : 'Avoid late evening irrigation to prevent blight.'
            ],
            agriculturalInputs: [
                isTa ? 'MOP (பொட்டாஷ்)' : 'Muriate of Potash (MOP)',
                isTa ? 'வெர்மிகம்போஸ்ட்' : 'Vermicompost',
                isTa ? 'துத்தநாக சல்பேட்' : 'Zinc Sulphate'
            ],
            diseases: [
                { name: isTa ? 'ஆரம்ப கால கருகல்' : 'Early Blight', symptoms: isTa ? 'இலைகளில் பழுப்பு நிற வளையங்கள்.' : 'Target-like brown spots on lower leaves.' },
                { name: isTa ? 'லேட் பிளைட் (பிந்தைய கருகல்)' : 'Late Blight', symptoms: isTa ? 'இலைகளின் அடியில் வெள்ளை நிறப் பூஞ்சை வளர்ச்சி.' : 'Water-soaked spots with white fungal growth underneath.' }
            ]
        }
    };

    const defaultData = {
        prevention: [isTa ? 'முறையான மண் ஆய்வு செய்யவும்.' : 'Conduct regular soil testing.', isTa ? 'தரமான விதைகளைத் தேர்ந்தெடுக்கவும்.' : 'Select high-quality certified seeds.'],
        treatment: [isTa ? 'அறிவிக்கப்பட்ட பூஞ்சான் கொல்லிகளைப் பயன்படுத்தவும்.' : 'Use recommended fungicides.', isTa ? 'பாதிக்கப்பட்ட செடிகளை அகற்றவும்.' : 'Remove and destroy affected plants.'],
        careTips: [isTa ? 'களைகளைக் கட்டுப்படுத்தவும்.' : 'Keep the field weed-free.', isTa ? 'முறையான நீர்ப்பாசனம் செய்யவும்.' : 'Ensure proper and timely irrigation.'],
        harvestingTips: [isTa ? 'சரியான பக்குவத்தில் அறுவடை செய்யவும்.' : 'Harvest at the right maturity stage.'],
        sustainablePractices: [isTa ? 'இயற்கை உரங்களைப் பயன்படுத்தவும்.' : 'Use more bio-fertilizers.'],
        irrigationStrategies: [isTa ? 'நீரைச் சிக்கனமாகப் பயன்படுத்தவும்.' : 'Optimize water usage.'],
        agriculturalInputs: [isTa ? 'N-P-K உரங்கள்' : 'N-P-K Fertilizers'],
        diseases: []
    };

    res.json(cropData[crop] || defaultData);
});

// --- END MISSING ENDPOINTS FIX ---

`;

const newContent = head + middle + tail;
fs.writeFileSync('c:/Users/elava/Documents/Project/Project/CropAI/server.js', newContent, 'utf8');
console.log('Successfully fixed server.js');
