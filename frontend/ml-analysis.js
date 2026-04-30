// Machine Learning Image Analysis
let mobilenetModel = null;
let isLoadingModel = false;

const cropPhotoInput = document.getElementById('cropPhoto');

function handleCropPhotoSelection(file) {
    if (!file) return false;

    const fileName = (file.name || '').toLowerCase();
    const looksLikeImage = (file.type && file.type.startsWith('image/')) || /\.(jpg|jpeg|png|webp|gif|bmp|avif|heic|heif)$/i.test(fileName);

    if (!looksLikeImage) {
        showToast('Please choose a valid image file', 'warning');
        return false;
    }

    const imgElement = document.getElementById('previewImg');
    const uploadArea = document.getElementById('uploadArea');
    const photoPreview = document.getElementById('photoPreview');
    if (!imgElement || !uploadArea || !photoPreview) return false;

    try {
        const previewUrl = URL.createObjectURL(file);
        imgElement.onload = () => URL.revokeObjectURL(previewUrl);
        imgElement.onerror = () => {
            URL.revokeObjectURL(previewUrl);
            const reader = new FileReader();
            reader.onload = () => {
                imgElement.src = reader.result;
            };
            reader.onerror = () => showToast('That file could not be opened as an image', 'danger');
            reader.readAsDataURL(file);
        };
        imgElement.src = previewUrl;
    } catch (err) {
        const reader = new FileReader();
        reader.onload = () => {
            imgElement.src = reader.result;
        };
        reader.onerror = () => showToast('That file could not be opened as an image', 'danger');
        reader.readAsDataURL(file);
    }
    uploadArea.style.display = 'none';
    photoPreview.style.display = 'block';
    imgElement.dataset.fileName = file.name || '';

    return true;
}

if (cropPhotoInput) {
    cropPhotoInput.addEventListener('change', function (e) {
        handleCropPhotoSelection(e.target.files[0]);
    });
}

const removeBtn = document.getElementById('removePhotoBtn');
if (removeBtn) {
    removeBtn.addEventListener('click', function () {
        if (cropPhotoInput) cropPhotoInput.value = '';
        const previewImg = document.getElementById('previewImg');
        if (previewImg) previewImg.src = '';

        const photoPreview = document.getElementById('photoPreview');
        if (photoPreview) photoPreview.style.display = 'none';

        const uploadArea = document.getElementById('uploadArea');
        if (uploadArea) uploadArea.style.display = 'block';

        const resultsCol = document.getElementById('resultsColumn');
        if (resultsCol) resultsCol.classList.add('d-none');

        const uploadCol = document.getElementById('uploadColumn');
        if (uploadCol) {
            uploadCol.classList.remove('col-lg-4');
            uploadCol.classList.add('col-lg-8', 'offset-md-2');
        }
    });
}

function normalizeAnalysisResult(source) {
    const input = source && typeof source === 'object' ? source : {};
    const boolish = (value) => ['true', 'yes', 'ready', 'mature', 'maturity', '1', 'detected', 'present'].includes(String(value ?? '').trim().toLowerCase());
    const listify = (value, fallback = []) => {
        if (Array.isArray(value)) return value.filter(Boolean);
        if (typeof value === 'string') return value.split(/\n|;|,/).map((item) => item.trim()).filter(Boolean);
        return fallback.filter(Boolean);
    };

    const topCropCandidate = Array.isArray(input.crop_candidates) && input.crop_candidates.length
        ? String(input.crop_candidates[0]?.name || '').trim()
        : '';
    const cropName = String(input.cropName || input.crop_name || input.cropIdentification?.name || input.crop || topCropCandidate).trim();
    const confidence = String(input.confidence || input.cropIdentification?.confidence || '').trim() || 'Low';
    const careTips = listify(input.careTips || input.care_tips, [
        input.care_tips?.watering,
        input.care_tips?.soil,
        input.care_tips?.sunlight,
        input.care_tips?.maintenance
    ]).slice(0, 4);
    const treatmentList = [
        ...listify(input.treatment, []),
        ...listify(input.treatment?.organic, []),
        ...listify(input.treatment?.chemical, []),
        ...listify(input.treatment?.preventive || input.treatment?.prevention, [])
    ].filter(Boolean).slice(0, 6);
    const symptomList = listify(input.symptoms, []).slice(0, 6);
    const reasoning = input.analysis_summary || input.reasoning || input.reason || input.notes || input.confidenceMessage || '';
    const healthStatus = String(input.healthStatus || input.health_status || input.healthStatusDetails?.overall || (boolish(input.diseaseDetected ?? input.disease_detected) ? 'Diseased' : 'Healthy')).trim() || 'Healthy';
    const diseaseName = String(input.diseaseName ?? input.disease_name ?? '').trim();
    const diseaseDetected = boolish(input.diseaseDetected ?? input.disease_detected ?? input.diseaseDetectionDetails?.detected);
    const diseaseSeverity = String(input.disease_severity || input.severity || '').trim();
    const immediateAction = String(
        input.immediateAction ||
        input.immediate_action ||
        input.treatment?.immediate_actions ||
        treatmentList[0] ||
        (diseaseDetected
            ? `Start field treatment for ${diseaseName || 'the detected issue'} and monitor spread over the next few days.`
            : 'Maintain proper irrigation, avoid waterlogging, and inspect the crop weekly for early disease or pest signs.')
    ).trim();
    const cropDisplayName = cropName || topCropCandidate || '';
    console.log('[CropAI] fallback title condition result:', {
        cropName,
        topCropCandidate,
        hasRenderableCropName: Boolean(cropDisplayName),
        chosenTitle: cropDisplayName
    });

    const normalized = {
        ...input,
        crop_name: cropDisplayName,
        cropName: cropDisplayName,
        confidence,
        cropDescription: input.cropDescription || input.crop_description || reasoning,
        health_status: healthStatus,
        healthStatus,
        disease_detected: diseaseDetected ? 'Yes' : 'No',
        diseaseDetected: diseaseDetected ? 'Yes' : 'No',
        diseaseName: diseaseName || (diseaseDetected ? 'Detected crop health issue' : 'No visible disease detected'),
        diseaseDescription: input.diseaseDescription ?? input.disease_description ?? input.diseaseDetails ?? input.disease_cause ?? (symptomList.length ? symptomList.join(', ') : (diseaseDetected ? 'Visible crop stress symptoms detected in the uploaded image.' : 'No major disease symptoms detected in the uploaded image.')),
        severity: diseaseSeverity || (diseaseDetected ? 'Moderate' : 'None'),
        disease_severity: diseaseSeverity || (diseaseDetected ? 'Moderate' : 'None'),
        harvest_ready: boolish(input.harvestReady ?? input.harvest_ready ?? input.growthStageDetails?.harvestReady) ? 'Yes' : 'No',
        harvestReady: boolish(input.harvestReady ?? input.harvest_ready ?? input.growthStageDetails?.harvestReady) ? 'Yes' : 'No',
        harvestNotes: input.harvestNotes || input.harvest_notes || input.harvest_timing || '',
        care_tips: careTips.length > 0 ? careTips : listify(input.care_tips, []),
        careTips,
        treatment: Array.isArray(input.treatment)
            ? { organic: treatmentList, chemical: [], preventive: [] }
            : input.treatment && typeof input.treatment === 'object'
                ? input.treatment
                : { organic: [], chemical: [], preventive: [] },
        fertilizerRecommendations: Array.isArray(input.fertilizerRecommendations || input.fertilizer_recommendations)
            ? (input.fertilizerRecommendations || input.fertilizer_recommendations)
            : [],
        monthlyRecommendationsData: input.monthlyRecommendationsData || input.monthlyRecommendations || input.monthly_recommendations || {
            current_month_tips: [],
            next_month_tips: [],
            watering_schedule: '',
            sunlight_needs: ''
        },
        reasoning,
        analysis_summary: reasoning,
        immediateAction,
        immediate_action: immediateAction,
        soilSuggestions: input.soilSuggestions || input.soil_suggestions || input.soil_health_tips || '',
        notes: reasoning || input.notes || '',
        symptoms: symptomList,
        crop_candidates: Array.isArray(input.crop_candidates) ? input.crop_candidates : []
    };

    console.log('[CropAI] normalized analysis object:', normalized);
    return normalized;
}
window.normalizeAnalysisResult = normalizeAnalysisResult;

function getAnalysisLanguage() {
    if (typeof window.getCurrentLanguage === 'function') {
        return window.getCurrentLanguage();
    }
    return localStorage.getItem('lang') || 'en';
}

function getAnalysisUiCopy(lang) {
    return {
        en: {
            analysisFailed: 'Analysis failed. Invalid data format.',
            invalidCrop: 'Invalid crop detection',
            cropDetectionUnavailable: 'Crop Detection Unavailable',
            analysisUnavailable: 'Analysis unavailable.',
            analysisUnavailableShort: 'Analysis unavailable',
            analysisCompleted: 'Analysis completed.',
            uploadedImageSummary: 'Analysis completed for the uploaded crop image.',
            healthStatus: 'Health Status',
            stage: 'Stage',
            health: 'Health',
            diseaseDetected: 'Disease detected',
            noVisibleDisease: 'No visible disease',
            pestSignsVisible: 'Pest signs visible',
            noVisiblePests: 'No visible pests',
            harvestReady: 'Harvest ready',
            notHarvestReady: 'Not harvest ready',
            confidence: 'Confidence',
            referenceMatch: 'Reference Match',
            matchedCrop: 'Matched crop',
            reasoning: 'Reasoning',
            diseaseStatus: 'Disease Status',
            pestStatus: 'Pest Status',
            careTips: 'Care Tips',
            noCareTips: 'No care tips available.',
            treatmentAdvice: 'Treatment Advice',
            fertilizerSuggestions: 'Fertilizer Suggestions',
            harvestGuidance: 'Harvest Guidance',
            readyStatus: 'Ready Status',
            timing: 'Timing',
            immediateAction: 'Immediate Action',
            monthlyRecommendations: 'Monthly Crop Recommendations',
            watering: 'Watering',
            sunlight: 'Sunlight',
            soilSuggestions: 'Soil Suggestions',
            topLikelyMatches: 'Top Likely Matches',
            cropIdentified: 'Crop Identified',
            likelyCrop: 'Likely Crop',
            needBetterImage: 'Need Better Image',
            yes: 'Yes',
            no: 'No',
            low: 'Low',
            medium: 'Medium',
            high: 'High',
            mild: 'Mild',
            moderate: 'Moderate',
            severe: 'Severe',
            none: 'None',
            healthy: 'Healthy',
            diseased: 'Diseased',
            readyForHarvest: 'Ready for harvest',
            notReadyYet: 'Not ready yet',
            active: 'Active',
            localFallbackAnalysis: 'Local fallback analysis'
        },
        ta: {
            analysisFailed: 'பகுப்பாய்வு தோல்வியடைந்தது. தரவு வடிவம் தவறானது.',
            invalidCrop: 'தவறான பயிர் கண்டறிதல்',
            cropDetectionUnavailable: 'பயிர் அடையாளம் காண முடியவில்லை',
            analysisUnavailable: 'பகுப்பாய்வு கிடைக்கவில்லை.',
            analysisUnavailableShort: 'பகுப்பாய்வு கிடைக்கவில்லை',
            analysisCompleted: 'பகுப்பாய்வு முடிந்தது.',
            uploadedImageSummary: 'பதிவேற்றப்பட்ட பயிர் படத்திற்கான பகுப்பாய்வு முடிந்தது.',
            healthStatus: 'ஆரோக்கிய நிலை',
            stage: 'வளர்ச்சி நிலை',
            health: 'ஆரோக்கியம்',
            diseaseDetected: 'நோய் கண்டறியப்பட்டது',
            noVisibleDisease: 'தெளிவான நோய் அறிகுறி இல்லை',
            pestSignsVisible: 'பூச்சி அறிகுறிகள் உள்ளன',
            noVisiblePests: 'தெளிவான பூச்சி அறிகுறி இல்லை',
            harvestReady: 'அறுவடைக்கு தயாராக உள்ளது',
            notHarvestReady: 'இன்னும் அறுவடைக்கு தயாராக இல்லை',
            confidence: 'நம்பகத்தன்மை',
            referenceMatch: 'ஒப்பீட்டு பொருத்தம்',
            matchedCrop: 'பொருந்திய பயிர்',
            reasoning: 'பகுப்பாய்வு விளக்கம்',
            diseaseStatus: 'நோய் நிலை',
            pestStatus: 'பூச்சி நிலை',
            careTips: 'பராமரிப்பு குறிப்புகள்',
            noCareTips: 'பராமரிப்பு குறிப்புகள் கிடைக்கவில்லை.',
            treatmentAdvice: 'சிகிச்சை ஆலோசனை',
            fertilizerSuggestions: 'உர பரிந்துரைகள்',
            harvestGuidance: 'அறுவடை வழிகாட்டல்',
            readyStatus: 'தயார்நிலை',
            timing: 'காலம்',
            immediateAction: 'உடனடி நடவடிக்கை',
            monthlyRecommendations: 'மாதாந்திர பயிர் பரிந்துரைகள்',
            watering: 'நீர்ப்பாசனம்',
            sunlight: 'சூரியஒளி',
            soilSuggestions: 'மண் பரிந்துரைகள்',
            topLikelyMatches: 'அதிகம் பொருந்தும் அடையாளங்கள்',
            cropIdentified: 'பயிர் அடையாளம் காணப்பட்டது',
            likelyCrop: 'சாத்தியமான பயிர்',
            needBetterImage: 'மேலும் தெளிவான படம் தேவை',
            yes: 'ஆம்',
            no: 'இல்லை',
            low: 'குறைவு',
            medium: 'மிதமான',
            high: 'அதிகம்',
            mild: 'லேசான',
            moderate: 'மிதமான',
            severe: 'கடுமையான',
            none: 'இல்லை',
            healthy: 'ஆரோக்கியமானது',
            diseased: 'நோய் பாதிப்பு உள்ளது',
            readyForHarvest: 'அறுவடைக்கு தயாராக உள்ளது',
            notReadyYet: 'இன்னும் தயாராக இல்லை',
            active: 'செயலில் உள்ளது',
            localFallbackAnalysis: 'உள்ளக மாற்று பகுப்பாய்வு'
        }
    }[lang] || {
        analysisFailed: 'Analysis failed. Invalid data format.'
    };
}

const ANALYSIS_CROP_NAME_MAP = {
    'psidium guajava': 'கொய்யா',
    'guava': 'கொய்யா',
    'artocarpus heterophyllus': 'பலா',
    'jackfruit': 'பலா',
    'manilkara zapota': 'சப்போட்டா',
    'sapota': 'சப்போட்டா',
    'mangifera indica': 'மா',
    'mango': 'மா',
    'musa paradisiaca': 'வாழை',
    'musa acuminata': 'வாழை',
    'banana': 'வாழை',
    'carica papaya': 'பப்பாளி',
    'papaya': 'பப்பாளி',
    'punica granatum': 'மாதுளை',
    'pomegranate': 'மாதுளை',
    'oryza sativa': 'நெல்',
    'rice': 'நெல்',
    'rice/paddy': 'நெல்',
    'zea mays': 'மக்காச்சோளம்',
    'maize': 'மக்காச்சோளம்',
    'solanum lycopersicum': 'தக்காளி',
    'tomato': 'தக்காளி',
    'cocos nucifera': 'தென்னை',
    'coconut': 'தென்னை'
};

const ANALYSIS_SENTENCE_MAP_TA = {
    'If necessary, apply a fungicide.': 'தேவைப்பட்டால் பூஞ்சைநாசினி பயன்படுத்தவும்.',
    "If you don't know the fungus species, choose fungicide based on the infected plant (e.g. house plant, garden plant, tree).": 'பாதிக்கப்பட்ட தாவரத்திற்கேற்ற பூஞ்சைநாசினியை தேர்வு செய்து பயன்படுத்தவும்.',
    'If possible remove and destroy the infected parts of the plant.': 'முடிந்தால் பாதிக்கப்பட்ட தாவரப்பகுதிகளை அகற்றி அழிக்கவும்.',
    'Burn it, toss it into the garbage, or bury it deeply.': 'அவற்றை எரிக்கவும், குப்பையில் போடவும் அல்லது ஆழமாக புதைக்கவும்.',
    'Do not compost.': 'அவற்றை உரக்குழியில் போட வேண்டாம்.',
    'Apply ecological products for plant protection (e.g. neem oil, baking soda, soap).': 'வேப்பெண்ணெய், பேக்கிங் சோடா, சோப்பு கரைசல் போன்ற இயற்கை தாவர பாதுகாப்பு பொருட்களை பயன்படுத்தலாம்.',
    'Use resistant species and cultivars as well as healthy, certified seeds and seedlings.': 'நோய் எதிர்ப்பு திறன் கொண்ட ரகங்களையும், ஆரோக்கியமான சான்றளிக்கப்பட்ட விதைகள் மற்றும் நாற்றுகளையும் பயன்படுத்தவும்.',
    'Ensure having good soil drainage to avoid overwatering.': 'அதிக நீர் தேங்காமல் இருக்க நல்ல வடிகால் வசதியை உறுதி செய்யவும்.',
    'Inspect nearby plants and remove badly affected leaves to reduce field spread.': 'அருகிலுள்ள தாவரங்களையும் பரிசோதித்து, தீவிரமாக பாதிக்கப்பட்ட இலைகளை அகற்றி நோய் பரவலை குறைக்கவும்.',
    'Remove damaged leaves and improve airflow.': 'சேதமடைந்த இலைகளை அகற்றி காற்றோட்டத்தை மேம்படுத்தவும்.',
    'Maintain balanced watering and monitor weekly.': 'சமநிலையான நீர்ப்பாசனம் வழங்கி வாரந்தோறும் கண்காணிக்கவும்.',
    'Use crop-appropriate treatment only if symptoms spread.': 'அறிகுறிகள் பரவத் தொடங்கினால் மட்டுமே பயிருக்கேற்ற சிகிச்சை மேற்கொள்ளவும்.',
    'Keep foliage dry and inspect regularly.': 'இலைப்பகுதி உலர்ந்திருக்கச் செய்து அவற்றை தடம் தவறாது பரிசோதிக்கவும்.',
    'Check watering, airflow, and leaf spots now.': 'நீர்ப்பாசனம், காற்றோட்டம் மற்றும் இலைப்புள்ளிகளை உடனே பரிசோதிக்கவும்.',
    'Continue normal crop care and monitoring.': 'சாதாரண பயிர் பராமரிப்பையும் கண்காணிப்பையும் தொடரவும்.',
    'Water at the base and avoid wet foliage.': 'செடியின் வேர் பகுதியில் நீர் வழங்கி இலைகள் நனைவதை தவிர்க்கவும்.',
    'Water deeply but avoid waterlogging.': 'ஆழமாக நீர் வழங்கவும்; ஆனால் நீர் தேங்க விட வேண்டாம்.',
    'Keep soil well drained and evenly moist.': 'மண் நல்ல வடிகாலுடன் சீரான ஈரப்பதத்தில் இருக்க வேண்டும்.',
    'Provide strong sunlight for most crops.': 'பெரும்பாலான பயிர்களுக்கு போதுமான சூரியஒளி கிடைக்க வேண்டும்.',
    'Inspect the crop weekly for changes.': 'பயிரில் மாற்றங்கள் உள்ளனவா என்பதை வாரந்தோறும் பரிசோதிக்கவும்.',
    'Monitor size, color, firmness, and maturity signs before harvest.': 'அறுவடைக்கு முன் அளவு, நிறம், உறுதி மற்றும் முதிர்ச்சி அறிகுறிகளை கவனிக்கவும்.',
    'No visible pest symptoms detected in this image.': 'இந்த படத்தில் தெளிவான பூச்சி அறிகுறிகள் காணப்படவில்லை.',
    'No major disease symptoms detected in the uploaded image.': 'பதிவேற்றப்பட்ட படத்தில் பெரிய நோய் அறிகுறிகள் கண்டறியப்படவில்லை.',
    'Visible crop stress symptoms detected in the uploaded image.': 'பதிவேற்றப்பட்ட படத்தில் பயிர் அழுத்த அறிகுறிகள் காணப்பட்டன.',
    'Analysis completed for the uploaded crop image.': 'பதிவேற்றப்பட்ட பயிர் படத்திற்கான பகுப்பாய்வு முடிந்தது.',
    'No additional technical notes.': 'கூடுதல் தொழில்நுட்ப குறிப்புகள் இல்லை.',
    'Analysis unavailable.': 'பகுப்பாய்வு கிடைக்கவில்லை.',
    'Analysis unavailable': 'பகுப்பாய்வு கிடைக்கவில்லை',
    'Not ready yet': 'இன்னும் தயாராக இல்லை',
    'Detected crop health issue': 'பயிர் ஆரோக்கியப் பிரச்சினை கண்டறியப்பட்டது',
    'No visible disease detected': 'தெளிவான நோய் அறிகுறி இல்லை',
    'Possible stress / discoloration': 'சாத்தியமான அழுத்தம் / நிறமாற்றம்',
    'Local fallback analysis': 'உள்ளக மாற்று பகுப்பாய்வு'
};

const ANALYSIS_TERM_REPLACEMENTS_TA = [
    [/Disease detected/gi, 'நோய் கண்டறியப்பட்டது'],
    [/No visible disease/gi, 'தெளிவான நோய் அறிகுறி இல்லை'],
    [/Pest signs visible/gi, 'பூச்சி அறிகுறிகள் உள்ளன'],
    [/No visible pests/gi, 'தெளிவான பூச்சி அறிகுறி இல்லை'],
    [/Harvest ready/gi, 'அறுவடைக்கு தயாராக உள்ளது'],
    [/Not harvest ready/gi, 'இன்னும் அறுவடைக்கு தயாராக இல்லை'],
    [/\bLow\b/gi, 'குறைவு'],
    [/\bMedium\b/gi, 'மிதமான'],
    [/\bHigh\b/gi, 'அதிகம்'],
    [/\bMild\b/gi, 'லேசான'],
    [/\bModerate\b/gi, 'மிதமான'],
    [/\bSevere\b/gi, 'கடுமையான'],
    [/\bHealthy\b/gi, 'ஆரோக்கியமானது'],
    [/\bDiseased\b/gi, 'நோய் பாதிப்பு உள்ளது'],
    [/\bYes\b/gi, 'ஆம்'],
    [/\bNo\b/gi, 'இல்லை'],
    [/\bActive\b/gi, 'செயலில் உள்ளது'],
    [/Crop Identified/gi, 'பயிர் அடையாளம் காணப்பட்டது'],
    [/Likely Crop/gi, 'சாத்தியமான பயிர்'],
    [/Need Better Image/gi, 'மேலும் தெளிவான படம் தேவை'],
    [/Reference Match/gi, 'ஒப்பீட்டு பொருத்தம்'],
    [/Matched crop/gi, 'பொருந்திய பயிர்'],
    [/Reasoning/gi, 'பகுப்பாய்வு விளக்கம்'],
    [/Disease Status/gi, 'நோய் நிலை'],
    [/Pest Status/gi, 'பூச்சி நிலை'],
    [/Care Tips/gi, 'பராமரிப்பு குறிப்புகள்'],
    [/Treatment Advice/gi, 'சிகிச்சை ஆலோசனை'],
    [/Fertilizer Suggestions/gi, 'உர பரிந்துரைகள்'],
    [/Harvest Guidance/gi, 'அறுவடை வழிகாட்டல்'],
    [/Ready Status/gi, 'தயார்நிலை'],
    [/Timing/gi, 'காலம்'],
    [/Immediate Action/gi, 'உடனடி நடவடிக்கை'],
    [/Monthly Crop Recommendations/gi, 'மாதாந்திர பயிர் பரிந்துரைகள்'],
    [/Watering/gi, 'நீர்ப்பாசனம்'],
    [/Sunlight/gi, 'சூரியஒளி'],
    [/Soil Suggestions/gi, 'மண் பரிந்துரைகள்'],
    [/Top Likely Matches/gi, 'அதிகம் பொருந்தும் அடையாளங்கள்'],
    [/Health Status/gi, 'ஆரோக்கிய நிலை']
];

function translateAnalysisStatus(value, lang) {
    const text = String(value ?? '').trim();
    if (!text || lang !== 'ta') return text;
    const copy = getAnalysisUiCopy(lang);
    const statusMap = {
        yes: copy.yes,
        no: copy.no,
        low: copy.low,
        medium: copy.medium,
        high: copy.high,
        mild: copy.mild,
        moderate: copy.moderate,
        severe: copy.severe,
        none: copy.none,
        healthy: copy.healthy,
        diseased: copy.diseased,
        'ready for harvest': copy.readyForHarvest,
        'not ready yet': copy.notReadyYet,
        active: copy.active,
        'crop identified': copy.cropIdentified,
        'likely crop': copy.likelyCrop,
        'need better image': copy.needBetterImage
    };
    return statusMap[text.toLowerCase()] || translateAnalysisDynamicText(text, lang);
}

function translateAnalysisDynamicText(text, lang) {
    const raw = typeof text === 'string' ? text : String(text ?? '');
    if (!raw || lang !== 'ta') return raw;

    let translated = raw;
    Object.entries(ANALYSIS_SENTENCE_MAP_TA).forEach(([source, target]) => {
        translated = translated.split(source).join(target);
    });
    ANALYSIS_TERM_REPLACEMENTS_TA.forEach(([pattern, replacement]) => {
        translated = translated.replace(pattern, replacement);
    });
    return translated.replace(/\s{2,}/g, ' ').trim();
}
window.translateAnalysisDynamicText = translateAnalysisDynamicText;

function formatAnalysisCropName(analysis, lang) {
    const rawCropName = String(analysis.cropName || analysis.crop_name || analysis.cropIdentification?.name || analysis.crop_candidates?.[0]?.name || '').trim();
    const scientificName = String(analysis.scientific_name || '').trim();
    if (lang !== 'ta') {
        return rawCropName || scientificName || getAnalysisUiCopy(lang).cropDetectionUnavailable;
    }

    const lookupKeys = [scientificName, rawCropName].filter(Boolean).map((value) => value.toLowerCase());
    const tamilCommonName = lookupKeys.map((key) => ANALYSIS_CROP_NAME_MAP[key]).find(Boolean);
    if (!tamilCommonName) {
        return rawCropName || scientificName || getAnalysisUiCopy(lang).cropDetectionUnavailable;
    }

    const referenceName = scientificName || rawCropName;
    return referenceName ? `${tamilCommonName} (${referenceName})` : tamilCommonName;
}

function displayAnalysisResults(analysis, container) {
    if (!container) container = document.getElementById('analysisContent');
    const lang = getAnalysisLanguage();
    const ui = getAnalysisUiCopy(lang);

    if (!analysis) {
        container.innerHTML = `<div class="alert alert-warning">${ui.analysisFailed}</div>`;
        return;
    }

    if (analysis.error === 'Invalid crop detection') {
        container.innerHTML = `
            <div class="card bg-dark border-danger border-opacity-25 shadow-lg overflow-hidden" style="border-radius: 20px;">
                <div class="card-body p-5 text-center">
                    <div class="display-1 text-danger mb-4 opacity-75">
                        <i class="fas fa-exclamation-circle"></i>
                    </div>
                    <h3 class="text-white fw-bold mb-3">${lang === 'ta' ? ui.invalidCrop : analysis.error}</h3>
                    <p class="text-white-50 lead mb-0">${translateAnalysisDynamicText(analysis.message, lang)}</p>
                </div>
            </div>
        `;
        return;
    }

    const boolish = (value) => ['true', 'yes', 'ready', 'mature', 'maturity', '1', 'detected', 'present'].includes(String(value ?? '').trim().toLowerCase());
    const listify = (value, fallback = []) => {
        if (Array.isArray(value)) return value.filter(Boolean);
        if (typeof value === 'string') return value.split(/\n|;|,/).map((item) => item.trim()).filter(Boolean);
        return fallback.filter(Boolean);
    };
    analysis = normalizeAnalysisResult(analysis);

    try {
        localStorage.setItem('lastAnalysisData', JSON.stringify(analysis));
    } catch (e) {}
    try {
        window.lastAnalysisData = analysis;
        window.dispatchEvent(new CustomEvent('cropai-analysis-updated', { detail: analysis }));
    } catch (e) {}

    const cropName = formatAnalysisCropName(analysis, lang);
    console.log('[CropAI] crop_name before rendering:', {
        cropName,
        rawCropName: analysis.crop_name,
        normalizedCropName: analysis.cropName,
        topCandidate: analysis.crop_candidates?.[0] || null
    });
    const subtitle = translateAnalysisDynamicText(analysis.analysis_summary || analysis.cropDescription || analysis.reasoning || ui.uploadedImageSummary, lang);
    const identificationStatus = translateAnalysisStatus(analysis.identificationStatus || (analysis.recognitionStatus === 'recognized' ? 'Crop Identified' : analysis.recognitionStatus === 'likely' ? 'Likely Crop' : 'Need Better Image'), lang);
    const confidenceRaw = analysis.confidence || analysis.cropIdentification?.confidence || analysis.crop_candidates?.[0]?.confidence || 'Low';
    const confidence = /^\d/.test(String(confidenceRaw).trim()) || String(confidenceRaw).includes('%')
        ? confidenceRaw
        : translateAnalysisStatus(confidenceRaw, lang);
    const growthStage = translateAnalysisDynamicText(analysis.growthStageName || analysis.growthStage || analysis.growth_stage || ui.active, lang);
    const healthStatus = translateAnalysisStatus(analysis.healthStatus || analysis.health_status || analysis.healthStatusDetails?.overall || 'Healthy', lang);
    const diseaseDetected = boolish(analysis.diseaseDetected ?? analysis.disease_detected ?? analysis.diseaseDetectionDetails?.detected);
    const diseaseName = translateAnalysisDynamicText(analysis.diseaseName || analysis.disease_name || (diseaseDetected ? 'Detected crop health issue' : 'No visible disease detected'), lang);
    const diseaseDetails = translateAnalysisDynamicText(
        analysis.diseaseDescription
        || analysis.diseaseDetails
        || analysis.disease_cause
        || (analysis.symptoms && analysis.symptoms.length ? analysis.symptoms.join(', ') : '')
        || (analysis.diseaseDetected === 'No' ? 'No visible disease detected' : 'Analysis unavailable.'),
        lang
    );
    const pestDetected = boolish(analysis.pestDetected);
    const pestDetails = translateAnalysisDynamicText(analysis.pestDetails || 'No visible pest symptoms detected in this image.', lang);
    const severity = translateAnalysisStatus(analysis.disease_severity || analysis.severity || analysis.diseaseDetectionDetails?.severity || (diseaseDetected ? 'Moderate' : 'None'), lang);
    const notes = translateAnalysisDynamicText(analysis.analysis_summary || analysis.reasoning || analysis.notes || analysis.confidenceMessage || 'No additional technical notes.', lang);
    const harvestReady = boolish(analysis.harvestReady ?? analysis.harvest_ready);
    const harvestTiming = translateAnalysisDynamicText(analysis.harvestNotes || analysis.harvest_notes || analysis.harvest_timing || analysis.harvestTiming || 'Not ready yet', lang);
    const harvestGuidance = translateAnalysisDynamicText(analysis.harvest_guidance || analysis.harvestGuidance || 'Monitor size, color, firmness, and maturity signs before harvest.', lang);
    const careTips = listify(analysis.careTips, [
        analysis.care_tips?.watering,
        analysis.care_tips?.soil,
        analysis.care_tips?.sunlight,
        analysis.care_tips?.maintenance
    ]).slice(0, 4).map((item) => translateAnalysisDynamicText(item, lang));
    const treatmentAdvice = [
        ...listify(analysis.treatment?.organic, []),
        ...listify(analysis.treatment?.chemical, []),
        ...listify(analysis.treatment?.preventive || analysis.treatment?.prevention, [])
    ].slice(0, 6).map((item) => translateAnalysisDynamicText(item, lang));
    const fertilizerSuggestion = Array.isArray(analysis.fertilizerRecommendations)
        ? analysis.fertilizerRecommendations
            .map((item) => {
                if (!item || typeof item !== 'object') return null;
                const bits = [item.name, item.purpose, item.dosage].filter(Boolean);
                return bits.join(' - ');
            })
            .filter(Boolean)
            .slice(0, 4).map((item) => translateAnalysisDynamicText(item, lang))
        : listify(analysis.fertilizerSuggestion, [analysis.fertilizer_plan]).slice(0, 4).map((item) => translateAnalysisDynamicText(item, lang));
    const immediateAction = translateAnalysisDynamicText(analysis.immediateAction
        || analysis.treatment?.immediate_actions
        || (Array.isArray(analysis.careTips) && analysis.careTips[0])
        || analysis.reasoning
        || ui.analysisCompleted, lang);
    const monthlyRecommendations = [
        ...listify(analysis.monthlyRecommendationsData?.current_month_tips, []),
        ...listify(analysis.monthlyRecommendationsData?.next_month_tips, [])
    ].slice(0, 4).map((item) => translateAnalysisDynamicText(item, lang));
    const wateringSchedule = translateAnalysisDynamicText(analysis.monthlyRecommendationsData?.watering_schedule || '', lang);
    const sunlightNeeds = translateAnalysisDynamicText(analysis.monthlyRecommendationsData?.sunlight_needs || '', lang);
    const soilSuggestions = translateAnalysisDynamicText(analysis.soilSuggestions || '', lang);
    const referenceImage = typeof getCropImage === 'function'
        ? getCropImage(String(analysis.cropName || analysis.crop_name || '').trim())
        : 'images/placeholder-crop.jpg';
    const actualUploadedImg = document.getElementById('previewImg') ? document.getElementById('previewImg').src : referenceImage;
    const severityKey = String(analysis.disease_severity || analysis.severity || analysis.diseaseDetectionDetails?.severity || (diseaseDetected ? 'Moderate' : 'None')).toLowerCase();
    const severityColor = severityKey === 'severe' ? '#ff3366' : severityKey === 'moderate' ? '#ff9900' : severityKey === 'mild' ? '#ffff00' : '#00ff88';
    const isHealthy = !diseaseDetected && String(analysis.healthStatus || analysis.health_status || '').trim().toLowerCase() === 'healthy';
    const healthClass = isHealthy ? 'health-excellent' : 'health-poor';

    container.innerHTML = `
        <div class="card bg-dark border-0 shadow-lg overflow-hidden" style="border-radius: 24px; background: rgba(10, 20, 15, 0.9) !important; border: 1px solid rgba(0, 255, 136, 0.2) !important;">
            <div class="card-header border-0 p-4" style="background: linear-gradient(135deg, rgba(0,255,136,0.1) 0%, transparent 100%);">
                <div class="d-flex justify-content-between align-items-start gap-3">
                    <div class="flex-grow-1">
                        <div class="d-flex align-items-center gap-3 mb-2">
                            <h3 class="text-white mb-0 fw-bold">${cropName}</h3>
                            <span class="badge" style="background: rgba(0, 255, 136, 0.1); color: ${severityColor}; border: 1px solid ${severityColor}44; font-size: 0.8rem; padding: 6px 12px;">
                                ${identificationStatus}
                            </span>
                        </div>
                        <p class="text-success-emphasis small fw-semibold mb-1">${ui.healthStatus}: ${healthStatus}</p>
                        <p class="text-white-50 small mb-3">${subtitle}</p>
                        <div class="d-flex flex-wrap gap-2">
                            <span class="badge bg-info bg-opacity-10 text-info border border-info border-opacity-20 px-2 py-1" style="font-size: 0.65rem;">${ui.stage}: ${growthStage}</span>
                            <span class="badge bg-secondary bg-opacity-10 text-white border border-secondary border-opacity-20 px-2 py-1" style="font-size: 0.65rem;">${ui.health}: ${healthStatus}</span>
                            <span class="badge ${diseaseDetected ? 'bg-danger bg-opacity-10 text-danger border border-danger border-opacity-20' : 'bg-success bg-opacity-10 text-success border border-success border-opacity-20'} px-2 py-1" style="font-size: 0.65rem;">${diseaseDetected ? ui.diseaseDetected : ui.noVisibleDisease}</span>
                            <span class="badge ${pestDetected ? 'bg-warning bg-opacity-10 text-warning border border-warning border-opacity-20' : 'bg-success bg-opacity-10 text-success border border-success border-opacity-20'} px-2 py-1" style="font-size: 0.65rem;">${pestDetected ? ui.pestSignsVisible : ui.noVisiblePests}</span>
                            <span class="badge ${harvestReady ? 'bg-warning bg-opacity-10 text-warning border border-warning border-opacity-20' : 'bg-secondary bg-opacity-10 text-white-50 border border-secondary border-opacity-20'} px-2 py-1" style="font-size: 0.65rem;">${harvestReady ? ui.harvestReady : ui.notHarvestReady}</span>
                        </div>
                    </div>
                    <div class="text-end">
                        <div class="health-score ${healthClass} h3 mb-0 fw-bold">${confidence}</div>
                        <small class="text-white-50 x-small text-uppercase" style="letter-spacing: 1px;">${ui.confidence}</small>
                    </div>
                </div>
            </div>

            <div class="card-body p-4 pt-0">
                <div class="row mb-4 g-4">
                    <div class="col-lg-5">
                        <div class="position-relative d-inline-block w-100 mb-3">
                            <img src="${actualUploadedImg}" alt="${cropName}" class="img-fluid rounded-4 shadow-lg border border-success border-opacity-15" style="max-height: 250px; width: 100%; object-fit: cover; aspect-ratio: 4/3;">
                        </div>
                        <div class="mt-2 mb-3 p-2 rounded-3 text-center" style="background: rgba(0, 255, 136, 0.05); border: 1px solid rgba(0, 255, 136, 0.1);">
                            <p class="x-small text-white-50 mb-1">${ui.referenceMatch}</p>
                            <img src="${referenceImage}" class="rounded-2 opacity-75" style="width: 60px; height: 40px; object-fit: cover;">
                            <small class="d-block x-small text-success mt-1">${ui.matchedCrop}: ${cropName}</small>
                        </div>
                        <div class="p-3 rounded-4" style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05);">
                            <h6 class="text-info x-small fw-bold mb-2 text-uppercase">${ui.reasoning}</h6>
                            <p class="x-small mb-0" style="color: rgba(255,255,255,0.7); line-height: 1.5;">${notes}</p>
                        </div>
                    </div>

                    <div class="col-lg-7">
                        <div class="row g-3 mb-4">
                            <div class="col-md-6">
                                <div class="p-3 rounded-4 h-100" style="background: rgba(255,153,0,0.03); border: 1px solid rgba(255,153,0,0.1);">
                                    <h6 class="text-warning x-small fw-bold mb-2 text-uppercase">${ui.diseaseStatus}</h6>
                                    <p class="small text-white mb-1 fw-bold">${diseaseName}</p>
                                    <p class="x-small text-white-50 mb-0">${diseaseDetails}</p>
                                </div>
                            </div>
                            <div class="col-md-6">
                                <div class="p-3 rounded-4 h-100" style="background: rgba(0,255,136,0.03); border: 1px solid rgba(0,255,136,0.1);">
                                    <h6 class="text-success x-small fw-bold mb-2 text-uppercase">${ui.pestStatus}</h6>
                                    <p class="x-small text-white-50 mb-0">${pestDetails}</p>
                                </div>
                            </div>
                        </div>

                        <div class="row g-4">
                            <div class="col-md-6">
                                <div class="h-100 p-3 rounded-4" style="background: rgba(0,255,136,0.05); border: 1px solid rgba(0,255,136,0.1);">
                                    <h6 class="text-success x-small fw-bold mb-3 text-uppercase">${ui.careTips}</h6>
                                    <ul class="list-unstyled mb-0">
                                        ${careTips.length
                                            ? careTips.map(item => `<li class="x-small text-white-75 mb-2" style="line-height: 1.6;"><i class="fas fa-check-circle text-success me-2"></i>${item}</li>`).join('')
                                            : `<li class="x-small text-white-75 mb-2" style="line-height: 1.6;"><i class="fas fa-check-circle text-success me-2"></i>${ui.noCareTips}</li>`}
                                    </ul>
                                </div>
                            </div>
                            <div class="col-md-6">
                                <div class="h-100 p-3 rounded-4" style="background: rgba(255,153,0,0.05); border: 1px solid rgba(255,153,0,0.1);">
                                    <h6 class="text-warning x-small fw-bold mb-3 text-uppercase">${ui.treatmentAdvice}</h6>
                                    ${treatmentAdvice.map(item => `<p class="x-small text-white-75 mb-2" style="line-height: 1.6;">${item}</p>`).join('')}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                ${fertilizerSuggestion.length ? `
                <div class="p-3 rounded-4 mb-4" style="background: rgba(236, 72, 153, 0.05); border: 1px solid rgba(236, 72, 153, 0.1);">
                    <h6 class="x-small fw-bold mb-3 text-uppercase text-center" style="letter-spacing: 2px; color: #f472b6;">${ui.fertilizerSuggestions}</h6>
                    ${fertilizerSuggestion.map(item => `<p class="x-small text-white-75 mb-2 text-center">${item}</p>`).join('')}
                </div>
                ` : ''}

                <div class="p-3 rounded-4 mb-4" style="background: rgba(255,183,0,0.07); border: 1px solid rgba(255,183,0,0.15);">
                    <h6 class="text-warning x-small fw-bold mb-3 text-uppercase text-center" style="letter-spacing: 2px;">${ui.harvestGuidance}</h6>
                    <div class="row g-3">
                        <div class="col-md-4"><div class="text-center p-2 rounded-3" style="background: rgba(255,255,255,0.03);"><p class="x-small text-white-50 mb-1">${ui.readyStatus}</p><span class="x-small fw-bold text-white d-block">${harvestReady ? ui.readyForHarvest : ui.notReadyYet}</span></div></div>
                        <div class="col-md-4"><div class="text-center p-2 rounded-3" style="background: rgba(255,255,255,0.03);"><p class="x-small text-white-50 mb-1">${ui.timing}</p><span class="x-small fw-bold text-white d-block">${harvestTiming}</span></div></div>
                        <div class="col-md-4"><div class="text-center p-2 rounded-3" style="background: rgba(255,255,255,0.03);"><p class="x-small text-white-50 mb-1">${ui.immediateAction}</p><span class="x-small fw-bold text-white d-block">${immediateAction}</span></div></div>
                    </div>
                    <div class="mt-3 p-3 rounded-3" style="background: rgba(0,0,0,0.18); border: 1px dashed rgba(255,183,0,0.25);">
                        <p class="x-small text-white-75 mb-0" style="line-height: 1.6;">${harvestGuidance}</p>
                    </div>
                </div>

                ${monthlyRecommendations.length ? `
                <div class="p-3 rounded-4 mb-4" style="background: rgba(147, 51, 234, 0.07); border: 1px solid rgba(147, 51, 234, 0.15);">
                    <h6 class="x-small fw-bold mb-3 text-uppercase text-center" style="letter-spacing: 2px; color: #c084fc;">${ui.monthlyRecommendations}</h6>
                    <div class="d-flex flex-wrap justify-content-center gap-2">
                        ${monthlyRecommendations.map(item => `<span class="badge" style="background: rgba(192, 132, 252, 0.1); color: #e879f9; border: 1px solid rgba(192, 132, 252, 0.3); font-size: 0.8rem; padding: 6px 12px; border-radius: 8px;">${item}</span>`).join('')}
                    </div>
                    ${wateringSchedule || sunlightNeeds ? `<div class="mt-3 text-center">
                        ${wateringSchedule ? `<p class="x-small text-white-75 mb-1">${ui.watering}: ${wateringSchedule}</p>` : ''}
                        ${sunlightNeeds ? `<p class="x-small text-white-75 mb-0">${ui.sunlight}: ${sunlightNeeds}</p>` : ''}
                    </div>` : ''}
                </div>
                ` : ''}

                ${soilSuggestions ? `
                <div class="p-3 rounded-4 mb-4" style="background: rgba(59, 130, 246, 0.07); border: 1px solid rgba(59, 130, 246, 0.15);">
                    <h6 class="x-small fw-bold mb-2 text-uppercase text-center" style="letter-spacing: 2px; color: #60a5fa;">${ui.soilSuggestions}</h6>
                    <p class="x-small text-white-75 mb-0 text-center">${soilSuggestions}</p>
                </div>
                ` : ''}

                ${analysis.top_predictions ? `
                <div class="mt-4 p-3 rounded-4 bg-dark bg-opacity-50 border border-secondary border-opacity-10 text-center">
                    <h6 class="x-small fw-bold mb-3 text-uppercase" style="letter-spacing: 2px; color: rgba(255,255,255,0.6);">${ui.topLikelyMatches}</h6>
                    <div class="d-flex flex-wrap justify-content-center gap-2">
                        ${analysis.top_predictions.map(p => `<span class="badge bg-dark border border-secondary border-opacity-20 px-3 py-2 text-white-50">${translateAnalysisDynamicText(p.name, lang)}: <span class="text-primary">${p.confidence}</span></span>`).join('')}
                    </div>
                </div>
                ` : ''}
            </div>
        </div>
    `;

    console.log('[CropAI] final object passed to renderAnalysis:', analysis);
    console.log('[CropAI] Final frontend-rendered result:', {
        cropName,
        confidence,
        identificationStatus,
        healthStatus,
        diseaseDetected,
        pestDetected,
        growthStage,
        harvestReady
    });

    if (typeof window.notifyContentRendered === 'function') {
        window.notifyContentRendered(container);
    }
    container.parentElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.displayAnalysisResults = displayAnalysisResults;
