(function () {
    const USER_KEY = 'cropai_current_user';
    const LOGIN_KEY = 'cropai_login_identifier';
    const API_BASE_KEY = 'cropai_api_base_url';
    const PLACEHOLDER_NAMES = new Set(['farmer', 'விவசாயி']);

    function safeStorageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function safeSessionGet(key) {
        try {
            return sessionStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function safeStorageSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // Ignore storage failures in private mode or blocked storage contexts.
        }
    }

    function safeSessionSet(key, value) {
        try {
            sessionStorage.setItem(key, value);
        } catch (e) {
            // Ignore storage failures.
        }
    }

    function safeStorageRemove(key) {
        try {
            localStorage.removeItem(key);
        } catch (e) {
            // Ignore storage failures.
        }
    }

    function safeSessionRemove(key) {
        try {
            sessionStorage.removeItem(key);
        } catch (e) {
            // Ignore storage failures.
        }
    }

    function isPlaceholderIdentityValue(value) {
        const cleaned = String(value || '').trim().toLowerCase();
        return PLACEHOLDER_NAMES.has(cleaned);
    }

    function getStoredCurrentUser() {
        try {
            const raw = safeStorageGet(USER_KEY) || safeSessionGet(USER_KEY);
            if (!raw) return null;
            return normalizeStoredUser(JSON.parse(raw));
        } catch (e) {
            return null;
        }
    }

    function setStoredCurrentUser(user) {
        const normalizedUser = normalizeStoredUser(user);
        if (!normalizedUser || typeof normalizedUser !== 'object') {
            safeStorageRemove(USER_KEY);
            safeSessionRemove(USER_KEY);
            return;
        }
        safeStorageSet(USER_KEY, JSON.stringify(normalizedUser));
        safeSessionSet(USER_KEY, JSON.stringify(normalizedUser));
    }

    function getStoredLoginIdentifier() {
        return String(safeStorageGet(LOGIN_KEY) || safeSessionGet(LOGIN_KEY) || '').trim();
    }

    function setStoredLoginIdentifier(identifier) {
        const value = String(identifier || '').trim();
        if (value) {
            safeStorageSet(LOGIN_KEY, value);
            safeSessionSet(LOGIN_KEY, value);
        }
    }

    function getDisplayName(value) {
        const cleaned = String(value || '').trim();
        if (!cleaned) return '';
        return cleaned.includes('@') ? cleaned.split('@')[0] : cleaned;
    }

    function getActualDisplayName(value) {
        const cleaned = getDisplayName(value);
        if (!cleaned) return '';
        return isPlaceholderIdentityValue(cleaned) ? '' : cleaned;
    }

    function normalizeStoredUser(user) {
        if (!user || typeof user !== 'object') return null;

        const normalized = { ...user };
        ['name', 'fullName', 'username', 'displayName', 'loginIdentifier'].forEach((key) => {
            if (!Object.prototype.hasOwnProperty.call(normalized, key)) return;
            if (isPlaceholderIdentityValue(normalized[key])) {
                normalized[key] = '';
            }
        });

        if (Object.prototype.hasOwnProperty.call(normalized, 'email')) {
            normalized.email = String(normalized.email || '').trim();
        }

        return normalized;
    }

    function getLocalizedFarmerFallback() {
        try {
            if (typeof window !== 'undefined' && typeof window.t === 'function') {
                const translated = String(window.t('dashboard.farmer_fallback') || '').trim();
                if (translated) return translated;
            }
        } catch (e) {
            // Fall through to language-based default.
        }

        try {
            const lang = String(safeStorageGet('lang') || '').trim().toLowerCase();
            return lang === 'ta' ? 'விவசாயி' : 'Farmer';
        } catch (e) {
            return 'Farmer';
        }
    }

    function resolveDisplayName(user) {
        const fromUser =
            getActualDisplayName(user?.name) ||
            getActualDisplayName(user?.fullName) ||
            getActualDisplayName(user?.username) ||
            getActualDisplayName(user?.displayName) ||
            getActualDisplayName(user?.loginIdentifier) ||
            getActualDisplayName(user?.email) ||
            getActualDisplayName(getStoredLoginIdentifier());

        if (fromUser) return fromUser;

        const cachedUser = getStoredCurrentUser();
        const fromCache =
            getActualDisplayName(cachedUser?.name) ||
            getActualDisplayName(cachedUser?.fullName) ||
            getActualDisplayName(cachedUser?.username) ||
            getActualDisplayName(cachedUser?.displayName) ||
            getActualDisplayName(cachedUser?.loginIdentifier) ||
            getActualDisplayName(cachedUser?.email);

        if (fromCache) return fromCache;

        return getLocalizedFarmerFallback();
    }

    function hasUsefulUserData(user) {
        return Boolean(
            getActualDisplayName(user?.name) ||
            getActualDisplayName(user?.fullName) ||
            getActualDisplayName(user?.username) ||
            getActualDisplayName(user?.displayName) ||
            getActualDisplayName(user?.loginIdentifier) ||
            getActualDisplayName(user?.email)
        );
    }

    function getApiBaseCandidates() {
        const currentOrigin = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null')
            ? window.location.origin
            : '';
        return [
            safeStorageGet(API_BASE_KEY),
            currentOrigin,
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:3001',
            'http://127.0.0.1:3001'
        ].filter(Boolean);
    }

    async function detectApiBase() {
        const candidates = [...new Set(getApiBaseCandidates())];

        for (const base of candidates) {
            try {
                const response = await fetch(`${base}/api/user`, {
                    method: 'GET',
                    credentials: 'include'
                });

                const contentType = response.headers.get('content-type') || '';
                const looksJson = contentType.includes('application/json');

                if (response.status === 401 || looksJson) {
                    safeStorageSet(API_BASE_KEY, base);
                    return base;
                }
            } catch (e) {
                // Try the next candidate.
            }
        }

        const fallback = candidates[0] || '';
        if (fallback) safeStorageSet(API_BASE_KEY, fallback);
        return fallback;
    }

    async function apiFetch(path, options = {}) {
        const base = await detectApiBase();
        const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${base}${path}`;
        const mergedOptions = {
            credentials: 'include',
            ...options
        };
        return fetch(url, mergedOptions);
    }

    async function resolveApiUrl(path) {
        if (path.startsWith('http://') || path.startsWith('https://')) {
            return path;
        }
        if (!path.startsWith('/api/')) {
            return path;
        }
        const base = await detectApiBase();
        return `${base}${path}`;
    }

    window.CropAIAuth = {
        getStoredCurrentUser,
        setStoredCurrentUser,
        getStoredLoginIdentifier,
        setStoredLoginIdentifier,
        resolveDisplayName,
        getLocalizedFarmerFallback,
        isPlaceholderIdentityValue,
        getActualDisplayName,
        normalizeStoredUser,
        hasUsefulUserData,
        detectApiBase,
        apiFetch,
        resolveApiUrl
    };
})();
