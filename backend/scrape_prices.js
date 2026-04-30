const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.vegetablemarketprice.com/market/tamilnadu/today';

function formatDateLabel(dateValue) {
    if (!dateValue) return 'Today';
    if (dateValue === 'today') return 'Today';

    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return dateValue;

    const day = String(date.getDate()).padStart(2, '0');
    const month = date.toLocaleString('en-US', { month: 'short' });
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

function buildCandidateUrls(dateValue) {
    if (!dateValue || dateValue === 'today') return [BASE_URL];

    const urls = [];

    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return urls;

    const iso = date.toISOString().slice(0, 10);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const monthShort = date.toLocaleString('en-US', { month: 'short' });
    const monthLong = date.toLocaleString('en-US', { month: 'long' });
    const year = date.getFullYear();
    const compact = `${day}${monthShort}${year}`;
    const dashed = `${day}-${monthShort}-${year}`;
    const numericDashed = `${day}-${month}-${year}`;
    const numericSlashed = `${day}/${month}/${year}`;

    urls.push(
        `${BASE_URL}?date=${encodeURIComponent(iso)}`,
        `${BASE_URL}?date=${encodeURIComponent(formatDateLabel(iso))}`,
        `${BASE_URL}?selectedDate=${encodeURIComponent(iso)}`,
        `https://www.vegetablemarketprice.com/market/tamilnadu/${encodeURIComponent(iso)}`,
        `https://www.vegetablemarketprice.com/market/tamilnadu/${encodeURIComponent(numericDashed)}`,
        `https://www.vegetablemarketprice.com/market/tamilnadu/${encodeURIComponent(numericSlashed)}`,
        `https://www.vegetablemarketprice.com/market/tamilnadu/${encodeURIComponent(dashed)}`,
        `https://www.vegetablemarketprice.com/market/tamilnadu/${encodeURIComponent(compact)}`,
        `https://www.vegetablemarketprice.com/market/tamilnadu/${encodeURIComponent(day)}/${encodeURIComponent(monthLong)}/${encodeURIComponent(year)}`
    );

    urls.push(BASE_URL);

    return [...new Set(urls)];
}

function normalizeName(rawName) {
    if (!rawName) return '';
    return rawName
        .replace(/\s*\([^)]*[\u0B80-\u0BFF][^)]*\)\s*$/u, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parsePrice(text) {
    const match = String(text || '').match(/₹\s*([\d,]+)/);
    if (match) return Number(match[1].replace(/,/g, ''));
    const digits = String(text || '').replace(/[^\d]/g, '');
    return digits ? Number(digits) : 0;
}

function parseRetailRange(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    const rangeMatch = cleaned.match(/₹\s*([\d,]+)\s*-\s*([\d,]+)/);
    if (rangeMatch) {
        return {
            min: Number(rangeMatch[1].replace(/,/g, '')),
            max: Number(rangeMatch[2].replace(/,/g, '')),
            label: `₹${rangeMatch[1]} - ${rangeMatch[2]}`
        };
    }

    const numberMatch = cleaned.match(/₹\s*([\d,]+)/);
    const value = numberMatch ? Number(numberMatch[1].replace(/,/g, '')) : 0;
    return {
        min: value,
        max: value,
        label: cleaned || '-'
    };
}

function resolveImageUrl(src) {
    if (!src) return '';
    if (src.startsWith('//')) return `https:${src}`;
    if (src.startsWith('http://') || src.startsWith('https://')) return src;
    return `https://www.vegetablemarketprice.com${src.startsWith('/') ? '' : '/'}${src}`;
}

function extractDateLabel($) {
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const labelMatch = bodyText.match(/\b\d{1,2}\/[A-Za-z]{3}\/\d{4}\b/);
    if (labelMatch) return labelMatch[0];
    return '';
}

async function fetchHtml(url) {
    const response = await axios.get(url, {
        timeout: 20000,
        responseType: 'text',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        },
        family: 4
    });
    return response.data;
}

async function scrapeVegetablePrices(requestedDate = 'today') {
    const candidateUrls = buildCandidateUrls(requestedDate);
    let lastError = null;

    for (const url of candidateUrls) {
        try {
            console.log(`Fetching data from: ${url}`);
            const html = await fetchHtml(url);
            const $ = cheerio.load(html);
            const rows = [];

            $('table tbody tr, table tr').each((index, row) => {
                const cells = $(row).find('td');
                if (!cells.length) return;

                const cellText = cells.map((_, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
                const rowText = cellText.join(' | ');
                if (!rowText || /Vegetable/i.test(rowText) || /Price/i.test(rowText) && /Retail Price/i.test(rowText)) {
                    return;
                }

                const img = $(row).find('img').first();
                const imageUrl = resolveImageUrl(img.attr('src') || img.attr('data-src') || '');

                let nameText = '';
                let priceText = '';
                let retailText = '';
                let unitsText = '';

                if (cells.length >= 4) {
                    nameText = $(cells[0]).text().replace(/\s+/g, ' ').trim();
                    priceText = $(cells[1]).text().replace(/\s+/g, ' ').trim();
                    retailText = $(cells[2]).text().replace(/\s+/g, ' ').trim();
                    unitsText = $(cells[3]).text().replace(/\s+/g, ' ').trim();
                } else {
                    nameText = rowText;
                    priceText = rowText;
                    retailText = rowText;
                    unitsText = rowText;
                }

                const name = normalizeName(nameText);
                const price = parsePrice(priceText);
                const retail = parseRetailRange(retailText);
                const units = unitsText || '1kg';

                if (!name || !price) return;

                rows.push({
                    name,
                    displayName: name,
                    price,
                    retailPrice: retail.label,
                    retailMin: retail.min,
                    retailMax: retail.max,
                    units,
                    imageUrl,
                    trend: 'stable'
                });
            });

            const uniqueRows = [];
            const seen = new Set();
            for (const row of rows) {
                const key = row.name.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                uniqueRows.push(row);
            }

            if (uniqueRows.length > 0) {
                return {
                    sourceUrl: url,
                    requestedDate,
                    sourceDateLabel: extractDateLabel($) || formatDateLabel(requestedDate),
                    fetchedAt: new Date().toISOString(),
                    rows: uniqueRows
                };
            }

            lastError = new Error('No vegetable rows found in the page');
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('Unable to scrape vegetable prices');
}

if (require.main === module) {
    scrapeVegetablePrices(process.argv[2] || 'today')
        .then(result => {
            console.log(JSON.stringify(result, null, 2));
        })
        .catch(error => {
            console.error('Error scraping vegetable prices:', error.message);
            process.exitCode = 1;
        });
}

module.exports = scrapeVegetablePrices;
