const LEGACY_ENV_NAMES = ['KINDWISE_CROP_HEALTH_URL', 'KINDWISE_API_URL'];

function sanitizeEnvValue(rawValue) {
    let value = String(rawValue || '').trim();
    if (!value) return '';

    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1).trim();
    }

    return value.replace(/[\r\n\t]/g, '').trim();
}

function maskSecret(value) {
    if (!value) return 'missing';
    return `${value.slice(0, 4)}***`;
}

function readRequiredEnv(name) {
    const value = sanitizeEnvValue(process.env[name]);
    if (!value) {
        console.error(`[CONFIG] Startup validation failed: ${name} is missing.`);
        throw new Error(`[CONFIG] Missing required environment variable: ${name}`);
    }
    return value;
}

function normalizeUrl(rawValue) {
    const normalized = sanitizeEnvValue(rawValue);
    if (!normalized) {
        throw new Error('[CONFIG] API URL is missing.');
    }

    let parsed;
    try {
        parsed = new URL(normalized);
    } catch (error) {
        throw new Error(`[CONFIG] Invalid URL format: ${normalized}`);
    }

    if (!['https:', 'http:'].includes(parsed.protocol)) {
        throw new Error(`[CONFIG] Unsupported URL protocol for ${normalized}. Use http or https.`);
    }

    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
}

function validateApiUrl(envName, rawValue, expectedHost, expectedPathPrefix) {
    const normalizedUrl = normalizeUrl(rawValue);
    const parsed = new URL(normalizedUrl);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';

    if (/\/docs$/i.test(pathname)) {
        throw new Error(`[CONFIG] ${envName} points to the docs page (${normalizedUrl}). Use the live API endpoint instead.`);
    }

    if (parsed.hostname !== expectedHost) {
        throw new Error(`[CONFIG] ${envName} must use host ${expectedHost}, but received ${parsed.hostname}.`);
    }

    if (!pathname.startsWith(expectedPathPrefix)) {
        throw new Error(`[CONFIG] ${envName} must start with ${expectedPathPrefix}, but received path ${pathname}.`);
    }

    return normalizedUrl;
}

function logExternalApiConfiguration(config) {
    console.log('[CONFIG] External API URLs:');
    console.log(`  plant.id -> ${config.plantId.apiUrl}`);
    console.log(`  crop.health -> ${config.cropHealth.apiUrl}`);
    console.log('[CONFIG] External API keys:');
    console.log(`  Plant.id key loaded: ${config.plantId.apiKey ? 'YES' : 'NO'}`);
    console.log(`  Plant.id key preview: ${maskSecret(config.plantId.apiKey)}`);
    console.log(`  Kindwise key loaded: ${config.cropHealth.apiKey ? 'YES' : 'NO'}`);
    console.log(`  Kindwise key preview: ${maskSecret(config.cropHealth.apiKey)}`);
}

function warnOnLegacyEnvUsage() {
    const activeLegacyVars = LEGACY_ENV_NAMES.filter((name) => String(process.env[name] || '').trim());
    if (!activeLegacyVars.length) return;

    console.warn(`[CONFIG] Legacy API URL env vars detected and ignored: ${activeLegacyVars.join(', ')}. Use PLANT_ID_API_URL and CROP_HEALTH_API_URL instead.`);
}

function loadExternalApiConfig() {
    warnOnLegacyEnvUsage();

    const config = {
        plantId: {
            apiKey: readRequiredEnv('PLANT_ID_API_KEY'),
            apiUrl: validateApiUrl('PLANT_ID_API_URL', readRequiredEnv('PLANT_ID_API_URL'), 'api.plant.id', '/v3/identification')
        },
        cropHealth: {
            apiKey: readRequiredEnv('KINDWISE_API_KEY'),
            apiUrl: validateApiUrl('CROP_HEALTH_API_URL', readRequiredEnv('CROP_HEALTH_API_URL'), 'crop.kindwise.com', '/api/v1/identification')
        }
    };

    logExternalApiConfiguration(config);
    return config;
}

module.exports = {
    externalApiConfig: loadExternalApiConfig(),
    maskSecret,
    normalizeUrl,
    sanitizeEnvValue,
    validateApiUrl
};
