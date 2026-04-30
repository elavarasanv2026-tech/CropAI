(function () {
    const STORAGE_KEY = 'lang';
    const LEGACY_STORAGE_KEYS = ['selectedLanguage'];
    const MANUAL_SELECTION_KEY = 'cropai_language_selected_manually';
    const DO_NOT_TRANSLATE = new Set(['English', 'Tamil', 'Hindi', 'Language']);
    function looksLikeMojibake(value) {
        return typeof value === 'string' && /(?:Ã.|Â.|à[\u0080-\u00FF]|â[\u0080-\u00FF]|ð[\u0080-\u00FF])/.test(value);
    }

    function repairMojibake(value) {
        if (!looksLikeMojibake(value)) return value;

        try {
            const bytes = Uint8Array.from(Array.from(value), (char) => char.charCodeAt(0) & 0xff);
            const repaired = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            return repaired || value;
        } catch (error) {
            return value;
        }
    }
    const OBSERVER_ATTRIBUTE_FILTER = [
        'data-i18n',
        'data-i18n-html',
        'data-i18n-placeholder',
        'data-i18n-title',
        'data-i18n-aria-label',
        'data-dynamic-text',
        'data-language-select'
    ];
    const STATIC_LANGUAGE_LABELS = {
        en: {
            english_label: 'English',
            tamil_label: 'Tamil (தமிழ்)'
        },
        ta: {
            english_label: 'English',
            tamil_label: 'தமிழ் (Tamil)'
        }
    };
    STATIC_LANGUAGE_LABELS.en.tamil_label = 'Tamil (தமிழ்)';
    STATIC_LANGUAGE_LABELS.ta.tamil_label = 'தமிழ் (Tamil)';

    const dynamicTranslators = new Map();
    let mutationObserver = null;
    let mutationTimer = null;
    let isApplyingTranslations = false;
    let suppressObserverUntil = 0;

    function shouldSkipDynamicTranslation(element) {
        if (!element) return true;
        if (element.getAttribute('data-dynamic-force-translate') === 'true') return false;
        return element.closest('[translate="no"]') || element.closest('.notranslate');
    }

    function getTranslations() {
        return window.CROPAI_TRANSLATIONS || { en: {}, ta: {} };
    }

    function safeLocalGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function safeSessionGet(key) {
        try {
            return sessionStorage.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function safeLocalSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (error) {
            // Ignore storage failures.
        }
    }

    function safeSessionSet(key, value) {
        try {
            sessionStorage.setItem(key, value);
        } catch (error) {
            // Ignore storage failures.
        }
    }

    function safeLocalRemove(key) {
        try {
            localStorage.removeItem(key);
        } catch (error) {
            // Ignore storage failures.
        }
    }

    function safeSessionRemove(key) {
        try {
            sessionStorage.removeItem(key);
        } catch (error) {
            // Ignore storage failures.
        }
    }

    function normalizeLanguage(value) {
        return value === 'ta' ? 'ta' : 'en';
    }

    function getForcedDefaultLanguage() {
        return normalizeLanguage(
            document.documentElement.getAttribute('data-force-default-language') || ''
        );
    }

    function hasManualLanguageSelection() {
        return safeLocalGet(MANUAL_SELECTION_KEY) === 'true';
    }

    function setManualLanguageSelection(lang, isManual) {
        if (isManual && normalizeLanguage(lang) === 'ta') {
            safeLocalSet(MANUAL_SELECTION_KEY, 'true');
            safeSessionSet(MANUAL_SELECTION_KEY, 'true');
            return;
        }

        safeLocalRemove(MANUAL_SELECTION_KEY);
        safeSessionRemove(MANUAL_SELECTION_KEY);
    }

    function writeLanguageCookie(key, value, maxAgeSeconds) {
        try {
            let cookie = `${key}=${value}; path=/; SameSite=Lax`;
            if (typeof maxAgeSeconds === 'number') {
                cookie += `; max-age=${maxAgeSeconds}`;
            }
            document.cookie = cookie;
        } catch (error) {
            // Ignore cookie failures.
        }
    }

    function expireLanguageCookie(key) {
        try {
            document.cookie = `${key}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
        } catch (error) {
            // Ignore cookie failures.
        }
    }

    function clearLegacyTamilPreference() {
        safeLocalSet(STORAGE_KEY, 'en');
        safeSessionSet(STORAGE_KEY, 'en');

        LEGACY_STORAGE_KEYS.forEach((key) => {
            safeLocalRemove(key);
            safeSessionRemove(key);
            expireLanguageCookie(key);
        });

        writeLanguageCookie(STORAGE_KEY, 'en', 31536000);
        expireLanguageCookie(MANUAL_SELECTION_KEY);
    }

    function sanitizeInitialLanguageState() {
        const forcedDefaultLanguage = getForcedDefaultLanguage();
        const savedLang = normalizeLanguage(safeLocalGet(STORAGE_KEY));
        const sessionLang = normalizeLanguage(safeSessionGet(STORAGE_KEY));
        const legacySelectedLanguage = normalizeLanguage(safeLocalGet('selectedLanguage'));
        const manualSelection = hasManualLanguageSelection();

        if (forcedDefaultLanguage === 'en') {
            clearLegacyTamilPreference();
            return 'en';
        }

        if (!manualSelection) {
            clearLegacyTamilPreference();
            return 'en';
        }

        const preferredLang =
            savedLang === 'ta' || sessionLang === 'ta' || legacySelectedLanguage === 'ta'
                ? 'ta'
                : 'en';

        safeLocalSet(STORAGE_KEY, preferredLang);
        safeSessionSet(STORAGE_KEY, preferredLang);
        LEGACY_STORAGE_KEYS.forEach((key) => {
            safeLocalSet(key, preferredLang);
            safeSessionSet(key, preferredLang);
        });
        writeLanguageCookie(STORAGE_KEY, preferredLang, 31536000);
        return preferredLang;
    }

    function getSavedLanguage() {
        return normalizeLanguage(safeLocalGet(STORAGE_KEY));
    }

    function setSavedLanguage(lang) {
        const normalizedLang = normalizeLanguage(lang);
        safeLocalSet(STORAGE_KEY, normalizedLang);
        safeSessionSet(STORAGE_KEY, normalizedLang);

        LEGACY_STORAGE_KEYS.forEach((key) => {
            safeLocalSet(key, normalizedLang);
            safeSessionSet(key, normalizedLang);
        });

        writeLanguageCookie(STORAGE_KEY, normalizedLang, 31536000);
        LEGACY_STORAGE_KEYS.forEach((key) => writeLanguageCookie(key, normalizedLang, 31536000));
    }

    function preserveStaticText(text) {
        const normalizedText = repairMojibake(text);
        return DO_NOT_TRANSLATE.has(normalizedText) ? normalizedText : normalizedText;
    }

    function isDynamicValueNode(element) {
        return Boolean(
            element &&
            (
                element.closest('[data-dynamic-text]') ||
                element.closest('[translate="no"]') ||
                element.closest('.notranslate')
            )
        );
    }

    function translateKey(key, lang) {
        const translations = getTranslations();
        const normalizedLang = normalizeLanguage(lang);
        const translated = (
            translations[normalizedLang]?.[key] ??
            translations.en?.[key] ??
            key
        );
        return preserveStaticText(translated);
    }

    function buildReverseLookup() {
        const translations = getTranslations();
        const reverse = {};
        Object.entries(translations.en || {}).forEach(([key, value]) => {
            if (typeof value === 'string' && value.trim()) {
                reverse[value.trim()] = key;
            }
        });
        return reverse;
    }

    function applyDataAttributeTranslations(lang) {
        document.querySelectorAll('[data-i18n]').forEach((element) => {
            const key = element.getAttribute('data-i18n');
            if (!key) return;
            element.textContent = translateKey(key, lang);
        });

        document.querySelectorAll('[data-i18n-html]').forEach((element) => {
            const key = element.getAttribute('data-i18n-html');
            if (!key) return;
            element.innerHTML = translateKey(key, lang);
        });

        document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
            const key = element.getAttribute('data-i18n-placeholder');
            if (!key) return;
            element.placeholder = translateKey(key, lang);
        });

        document.querySelectorAll('[data-i18n-title]').forEach((element) => {
            const key = element.getAttribute('data-i18n-title');
            if (!key) return;
            element.title = translateKey(key, lang);
        });

        document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
            const key = element.getAttribute('data-i18n-aria-label');
            if (!key) return;
            element.setAttribute('aria-label', translateKey(key, lang));
        });
    }

    function applyFallbackTranslations(lang) {
        const reverseLookup = buildReverseLookup();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node || !node.nodeValue) return NodeFilter.FILTER_REJECT;
                if (!node.parentElement) return NodeFilter.FILTER_REJECT;
                const tagName = node.parentElement.tagName;
                if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tagName)) return NodeFilter.FILTER_REJECT;
                if (
                    node.parentElement.closest('[data-language-select]') ||
                    isDynamicValueNode(node.parentElement) ||
                    node.parentElement.closest('[translate="no"]') ||
                    node.parentElement.closest('.notranslate')
                ) {
                    return NodeFilter.FILTER_REJECT;
                }
                const text = node.nodeValue.trim();
                return text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
        });

        const textNodes = [];
        let currentNode;
        while ((currentNode = walker.nextNode())) {
            textNodes.push(currentNode);
        }

        textNodes.forEach((node) => {
            const text = node.nodeValue.trim();
            if (DO_NOT_TRANSLATE.has(text)) return;
            const key = reverseLookup[text];
            if (!key) return;
            node.nodeValue = node.nodeValue.replace(text, translateKey(key, lang));
        });

        document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach((element) => {
            const currentPlaceholder = String(element.placeholder || '').trim();
            if (DO_NOT_TRANSLATE.has(currentPlaceholder)) return;
            const key = reverseLookup[currentPlaceholder];
            if (key) {
                element.placeholder = translateKey(key, lang);
            }
        });

        document.querySelectorAll('[title]').forEach((element) => {
            const currentTitle = String(element.title || '').trim();
            if (DO_NOT_TRANSLATE.has(currentTitle)) return;
            const key = reverseLookup[currentTitle];
            if (key) {
                element.title = translateKey(key, lang);
            }
        });

        document.querySelectorAll('[aria-label]').forEach((element) => {
            const currentAria = String(element.getAttribute('aria-label') || '').trim();
            if (DO_NOT_TRANSLATE.has(currentAria)) return;
            const key = reverseLookup[currentAria];
            if (key) {
                element.setAttribute('aria-label', translateKey(key, lang));
            }
        });
    }

    function enforceStaticLanguageSelectorLabels(lang) {
        const normalizedLang = normalizeLanguage(lang);
        const labels = STATIC_LANGUAGE_LABELS[normalizedLang] || STATIC_LANGUAGE_LABELS.en;

        document.querySelectorAll('#langSelect, #settingsLangSelect, [data-language-select]').forEach((select) => {
            if (!select) return;

            select.setAttribute('translate', 'no');
            select.classList.add('notranslate');

            Array.from(select.options || []).forEach((option) => {
                option.setAttribute('translate', 'no');
                option.classList.add('notranslate');

                if (option.value === 'en') {
                    option.textContent = labels.english_label;
                } else if (option.value === 'ta') {
                    option.textContent = labels.tamil_label;
                }
            });
        });
    }

    function syncLanguageSelectors(lang) {
        document.querySelectorAll('#langSelect, #settingsLangSelect, [data-language-select]').forEach((select) => {
            if (select && select.value !== lang) {
                select.value = lang;
            }
        });
        enforceStaticLanguageSelectorLabels(lang);
    }

    function registerDynamicTranslator(name, translator) {
        if (!name || typeof translator !== 'function') return;
        dynamicTranslators.set(String(name), translator);
    }

    function unregisterDynamicTranslator(name) {
        if (!name) return;
        dynamicTranslators.delete(String(name));
    }

    function runDynamicTranslators(value, lang, element) {
        return Array.from(dynamicTranslators.values()).reduce((currentValue, translator) => {
            try {
                const nextValue = translator(currentValue, lang, element);
                return typeof nextValue === 'string' ? nextValue : currentValue;
            } catch (error) {
                return currentValue;
            }
        }, String(value || ''));
    }

    function applyDynamicTextTranslations(lang, root) {
        const normalizedLang = normalizeLanguage(lang);
        const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
        scope.querySelectorAll('[data-dynamic-text]').forEach((element) => {
            if (!element || shouldSkipDynamicTranslation(element)) return;
            const sourceText = String(element.textContent || '');
            if (!sourceText.trim()) return;
            if (normalizedLang === 'en') return;
            const translatedText = runDynamicTranslators(sourceText, normalizedLang, element);
            if (translatedText && translatedText !== sourceText) {
                element.textContent = translatedText;
            }
        });
    }

    function getCurrentLanguage() {
        return normalizeLanguage(
            document.documentElement.getAttribute('data-language') ||
            safeLocalGet(STORAGE_KEY) ||
            'en'
        );
    }

    function shouldReapplyForMutations(mutations) {
        return Array.isArray(mutations) && mutations.some((mutation) => {
            if (!mutation) return false;
            if (mutation.type === 'childList') {
                return mutation.addedNodes?.length || mutation.removedNodes?.length;
            }
            if (mutation.type === 'attributes') {
                return OBSERVER_ATTRIBUTE_FILTER.includes(mutation.attributeName);
            }
            if (mutation.type === 'characterData') {
                return Boolean(mutation.target?.nodeValue?.trim());
            }
            return false;
        });
    }

    function scheduleApplyTranslations(lang) {
        if (mutationTimer) {
            clearTimeout(mutationTimer);
        }
        mutationTimer = setTimeout(() => {
            mutationTimer = null;
            applyTranslations(lang || getCurrentLanguage(), { source: 'observer' });
        }, 80);
    }

    function observeFutureContent() {
        if (mutationObserver || !document.body || typeof MutationObserver !== 'function') return;
        mutationObserver = new MutationObserver((mutations) => {
            if (isApplyingTranslations || Date.now() < suppressObserverUntil) return;
            if (!shouldReapplyForMutations(mutations)) return;
            scheduleApplyTranslations(getCurrentLanguage());
        });
        mutationObserver.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: OBSERVER_ATTRIBUTE_FILTER
        });
    }

    function notifyContentRendered(root) {
        applyDynamicTextTranslations(getCurrentLanguage(), root || document);
        scheduleApplyTranslations(getCurrentLanguage());
    }

    function applyTranslations(lang) {
        const normalizedLang = normalizeLanguage(lang);
        suppressObserverUntil = Date.now() + 150;
        isApplyingTranslations = true;
        try {
            document.documentElement.lang = normalizedLang;
            document.documentElement.setAttribute('data-language', normalizedLang);

            if (document.body) {
                document.body.classList.toggle('lang-ta', normalizedLang === 'ta');
            }

            applyDataAttributeTranslations(normalizedLang);
            applyFallbackTranslations(normalizedLang);
            syncLanguageSelectors(normalizedLang);

            if (typeof window.applyPageTranslations === 'function') {
                window.applyPageTranslations(normalizedLang);
            }

            applyDynamicTextTranslations(normalizedLang);

            document.dispatchEvent(new CustomEvent('cropai:language-changed', {
                detail: { lang: normalizedLang }
            }));
        } finally {
            isApplyingTranslations = false;
        }
    }

    function setLanguage(lang, options) {
        const normalizedLang = normalizeLanguage(lang);
        const settings = options || {};
        const isManualSelection = settings.manual !== false;

        setManualLanguageSelection(normalizedLang, isManualSelection);
        setSavedLanguage(normalizedLang);
        applyTranslations(normalizedLang);
        return normalizedLang;
    }

    function t(key, lang) {
        return translateKey(key, lang || getSavedLanguage());
    }

    function wireLanguageSelectors() {
        document.querySelectorAll('#langSelect, #settingsLangSelect, [data-language-select]').forEach((select) => {
            if (select.dataset.i18nBound === 'true') return;
            select.dataset.i18nBound = 'true';
            select.addEventListener('change', function () {
                setLanguage(this.value, { manual: true });
            });
        });
    }

    function init() {
        const initialLang = sanitizeInitialLanguageState();
        wireLanguageSelectors();
        applyTranslations(initialLang);
        observeFutureContent();
    }

    window.getSavedLanguage = getSavedLanguage;
    window.getCurrentLanguage = getCurrentLanguage;
    window.applyGlobalLanguage = function () {
        return applyTranslations(getCurrentLanguage());
    };
    window.applyTranslations = applyTranslations;
    window.setLanguage = setLanguage;
    window.t = t;
    window.registerDynamicTranslator = registerDynamicTranslator;
    window.unregisterDynamicTranslator = unregisterDynamicTranslator;
    window.notifyContentRendered = notifyContentRendered;
    window.CropAII18n = {
        init,
        t,
        setLanguage,
        getSavedLanguage,
        getCurrentLanguage,
        applyTranslations,
        registerDynamicTranslator,
        unregisterDynamicTranslator,
        notifyContentRendered
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
