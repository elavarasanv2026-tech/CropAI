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
const REQUEST_TIMEOUT_MS = Number(readEnv('EXTERNAL_API_TIMEOUT_MS')) || 15000;

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

  if (error.code === 'ECONNABORTED' || /timeout/i.test(String(detail || ''))) {
    return {
      status: 504,
      body: {
        success: false,
        error: fallbackMessage || 'External API request timed out.',
        details: detail,
        source
      }
    };
  }

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

function normalizeCandidateUrl(candidate) {
  return sanitizeEnvValue(candidate).replace(/\/+$/, '');
}

function buildApiUrlCandidates(primaryUrl, fallbacks = []) {
  const unique = new Set();
  const ordered = [primaryUrl, ...fallbacks]
    .map(normalizeCandidateUrl)
    .filter(Boolean)
    .filter((url) => {
      if (unique.has(url)) return false;
      unique.add(url);
      return true;
    });

  return ordered;
}

function shouldTryNextEndpoint(error) {
  const status = Number(error?.response?.status || 0);
  if (!status) return true;
  if (status === 404 || status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

async function postJsonWithFallbacks({ urls, payload, headers, params, sourceLabel }) {
  const errors = [];

  for (const url of urls) {
    try {
      const response = await axios.post(url, payload, {
        params,
        headers,
        timeout: REQUEST_TIMEOUT_MS
      });

      console.log(`[${sourceLabel}] Response status from ${url}:`, response.status);
      console.log(`[${sourceLabel}] Response data from ${url}:`, JSON.stringify(response.data));
      return response.data;
    } catch (error) {
      error.externalApi = error.externalApi || sourceLabel.toLowerCase();
      error.requestUrl = url;
      errors.push(error);
      console.error(`[${sourceLabel}] Request failed for ${url}:`, error.message);
      console.error(`[${sourceLabel}] Response status:`, error.response?.status || null);
      console.error(`[${sourceLabel}] Response data:`, JSON.stringify(error.response?.data || null));

      if (!shouldTryNextEndpoint(error) || url === urls[urls.length - 1]) {
        throw error;
      }
    }
  }

  throw errors[errors.length - 1] || new Error(`${sourceLabel} request failed.`);
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
  const candidateUrls = buildApiUrlCandidates(externalApiConfig.cropHealth.apiUrl, [
    'https://crop.kindwise.com/api/v1/identification',
    'https://plant.id/api/v3/health_assessment'
  ]);

  console.log('[PLANT.HEALTH] Calling disease analysis API...');
  console.log('[PLANT.HEALTH] source = plant.health');
  console.log('[PLANT.HEALTH] Request URL candidates:', candidateUrls);
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
    return await postJsonWithFallbacks({
      urls: candidateUrls,
      payload,
      params: {
        details: 'disease_details,treatment'
      },
      headers: {
        'Api-Key': KINDWISE_KEY,
        'Content-Type': 'application/json'
      },
      sourceLabel: 'PLANT.HEALTH'
    });
  } catch (error) {
    error.externalApi = 'plant.health';
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
  const candidateUrls = buildApiUrlCandidates(externalApiConfig.plantId.apiUrl, [
    'https://plant.id/api/v3/identification',
    'https://api.plant.id/v3/identification'
  ]);

  console.log('[PLANT.ID] Calling plant.id API...');
  console.log('[PLANT.ID] Request URL candidates:', candidateUrls);
  console.log('[PLANT.ID] API key exists:', PLANT_ID_KEY ? 'YES' : 'NO');
  console.log('[PLANT.ID] Masked key preview:', maskKey(PLANT_ID_KEY));
  console.log('[PLANT.ID] Header names:', ['Api-Key', 'Content-Type']);
  console.log('[PLANT.ID] Request payload size:', payloadSize);

  try {
    return await postJsonWithFallbacks({
      urls: candidateUrls,
      payload,
      headers: {
        'Api-Key': PLANT_ID_KEY,
        'Content-Type': 'application/json'
      },
      sourceLabel: 'PLANT.ID'
    });
  } catch (error) {
    error.externalApi = 'plant.id';
    throw error;
  }
}

module.exports = {
  externalApiConfig,
  mapExternalApiError,
  requestCropHealthIdentification,
  requestPlantIdIdentification
};
