const axios = require('axios');

function sanitizeEnvValue(value) {
  let sanitized = String(value || '').trim();
  if (!sanitized) return '';

  if (
    (sanitized.startsWith('"') && sanitized.endsWith('"')) ||
    (sanitized.startsWith("'") && sanitized.endsWith("'"))
  ) {
    sanitized = sanitized.slice(1, -1).trim();
  }

  return sanitized.replace(/[\r\n\t]/g, '').trim();
}

function readEnv(name) {
  return sanitizeEnvValue(process.env[name]);
}

function maskKey(value) {
  if (!value) return 'missing';
  return `${value.slice(0, 4)}***`;
}

const PLANT_ID_KEY = readEnv('PLANT_ID_API_KEY');
const KINDWISE_KEY = readEnv('KINDWISE_API_KEY');
const PLANT_ID_API_URL = readEnv('PLANT_ID_API_URL') || 'https://api.plant.id/v3/identification';
const CROP_HEALTH_API_URL = readEnv('CROP_HEALTH_API_URL') || 'https://plant.id/api/v3/health_assessment';

const externalApiConfig = {
  plantId: {
    apiKey: PLANT_ID_KEY,
    apiUrl: PLANT_ID_API_URL
  },
  cropHealth: {
    apiKey: KINDWISE_KEY,
    apiUrl: CROP_HEALTH_API_URL
  }
};

function validateStartupConfig() {
  console.log('[CONFIG] Startup validation for external APIs');
  console.log(`[CONFIG] Plant.id key loaded: ${PLANT_ID_KEY ? 'YES' : 'NO'} (${maskKey(PLANT_ID_KEY)})`);
  console.log(`[CONFIG] Disease analysis key loaded: ${KINDWISE_KEY ? 'YES' : 'NO'} (${maskKey(KINDWISE_KEY)})`);
  console.log(`[CONFIG] Plant.id URL: ${PLANT_ID_API_URL || 'missing'}`);
  console.log(`[CONFIG] Disease analysis URL: ${CROP_HEALTH_API_URL || 'missing'}`);

  if (!PLANT_ID_KEY) {
    throw new Error('[CONFIG] PLANT_ID_API_KEY is missing after .env load.');
  }

  if (!KINDWISE_KEY) {
    throw new Error('[CONFIG] KINDWISE_API_KEY is missing after .env load.');
  }

  if (!CROP_HEALTH_API_URL) {
    throw new Error('[CONFIG] CROP_HEALTH_API_URL is missing after .env load.');
  }
}

validateStartupConfig();

function mapExternalApiError(error, fallbackMessage) {
  const status = error.response?.status;
  const source = error.externalApi || 'external-api';
  const detail =
    error.response?.data?.detail ||
    error.response?.data?.message ||
    error.response?.data?.error ||
    error.message;

  if (status === 401 || status === 403) {
    if (source === 'crop.health') {
      return {
        status,
        body: {
          success: false,
          source: 'crop.health',
          error: 'Crop.health authentication failed',
          details: 'Invalid crop.health API key, wrong auth header, wrong endpoint, or wrong key-to-API pairing'
        }
      };
    }

    return {
      status: status,
      body: {
        success: false,
        error: 'External API authentication failed',
        details: detail,
        source
      }
    };
  }
  if (status === 429) {
    return {
      status: 429,
      body: { success: false, error: 'API rate limit reached. Please try again later.' }
    };
  }
  return {
    status: status || 500,
    body: {
      success: false,
      error: fallbackMessage || detail,
      details: detail,
      source
    }
  };
}

async function requestCropHealthIdentification({ base64Image }) {
  if (!KINDWISE_KEY) {
    throw new Error('KINDWISE_API_KEY is missing from .env');
  }
  if (!externalApiConfig.cropHealth.apiUrl) {
    throw new Error('CROP_HEALTH_API_URL is missing from .env');
  }

  const payload = {
    images: [`data:image/jpeg;base64,${base64Image}`],
    similar_images: true
  };
  const payloadSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');

  console.log('[PLANT.HEALTH] Calling disease analysis API...');
  console.log('[PLANT.HEALTH] source = plant.health');
  console.log('[PLANT.HEALTH] Request URL:', externalApiConfig.cropHealth.apiUrl);
  console.log('[PLANT.HEALTH] API key exists:', KINDWISE_KEY ? 'YES' : 'NO');
  console.log('[PLANT.HEALTH] Masked key preview:', maskKey(KINDWISE_KEY));
  console.log('[PLANT.HEALTH] Header names:', ['Api-Key', 'Content-Type']);
  console.log('[PLANT.HEALTH] Request payload size:', payloadSize);
  console.log('[PLANT.HEALTH] Payload summary:', {
    imageCount: payload.images.length,
    firstImageLength: payload.images[0]?.length || 0,
    similar_images: payload.similar_images
  });

  try {
    const response = await axios.post(
      externalApiConfig.cropHealth.apiUrl,
      payload,
      {
        params: {
          details: 'disease_details,treatment'
        },
        headers: {
          'Api-Key': KINDWISE_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    console.log('[PLANT.HEALTH] Response status:', response.status);
    console.log('[PLANT.HEALTH] Response data:', JSON.stringify(response.data));

    return response.data;
  } catch (error) {
    error.externalApi = 'plant.health';
    console.error('[PLANT.HEALTH] Response status:', error.response?.status || null);
    console.error('[PLANT.HEALTH] Response data:', JSON.stringify(error.response?.data || null));
    console.error('[PLANT.HEALTH] error.response?.data:', JSON.stringify(error.response?.data || null));
    throw error;
  }
}

async function requestPlantIdIdentification({ base64Image }) {
  if (!PLANT_ID_KEY) {
    throw new Error('PLANT_ID_API_KEY is missing from .env');
  }

  const payload = {
    images: [`data:image/jpeg;base64,${base64Image}`],
    similar_images: true
  };
  const payloadSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');

  console.log('[PLANT.ID] Calling plant.id API...');
  console.log('[PLANT.ID] Request URL:', externalApiConfig.plantId.apiUrl);
  console.log('[PLANT.ID] API key exists:', PLANT_ID_KEY ? 'YES' : 'NO');
  console.log('[PLANT.ID] Masked key preview:', maskKey(PLANT_ID_KEY));
  console.log('[PLANT.ID] Header names:', ['Api-Key', 'Content-Type']);
  console.log('[PLANT.ID] Request payload size:', payloadSize);

  try {
    const response = await axios.post(
      externalApiConfig.plantId.apiUrl,
      payload,
      {
        headers: {
          'Api-Key': PLANT_ID_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    console.log('[PLANT.ID] Response status:', response.status);
    console.log('[PLANT.ID] Response data:', JSON.stringify(response.data));

    return response.data;
  } catch (error) {
    error.externalApi = 'plant.id';
    console.error('[PLANT.ID] Response status:', error.response?.status || null);
    console.error('[PLANT.ID] Response data:', JSON.stringify(error.response?.data || null));
    console.error('[PLANT.ID] error.response?.data:', JSON.stringify(error.response?.data || null));
    throw error;
  }
}

module.exports = {
  externalApiConfig,
  mapExternalApiError,
  requestCropHealthIdentification,
  requestPlantIdIdentification
};
