const fs = require('fs');
let b = fs.readFileSync('server.js', 'utf8');

// The messed up string
const badStart = 'text: ph_val >= 6.0 && ph_val <= 7.5 ?         if (!isConfigured) {';
const badEndIndex = b.indexOf('Consider pulses to improve soil texture and health.\'),');

if (b.indexOf(badStart) !== -1 && badEndIndex !== -1) {
    const startIndex = b.indexOf(badStart);
    const endIndex = badEndIndex + 'Consider pulses to improve soil texture and health.\'),'.length;

    const before = b.substring(0, startIndex);
    const after = b.substring(endIndex);

    const replacement = `text: ph_val >= 6.0 && ph_val <= 7.5 ? (isTa ? '\\u0b87\\u0ba8\\u0bcd\\u0ba4 \\u0bae\\u0ba3\\u0bcd \\u0ba8\\u0bc6\\u0bb2\\u0bcd, \\u0b95\\u0bb0\\u0bc1\\u0bae\\u0bcd\\u0baa\\u0bc1 \\u0bae\\u0bb1\\u0bcd\\u0bb1\\u0bc1\\u0bae\\u0bcd \\u0b95\\u0bbe\\u0baf\\u0bcd\\u0b95\\u0bb1\\u0bbf\\u0b95\\u0bb3\\u0bc1\\u0b95\\u0bcd\\u0b95\\u0bc1 \\u0bae\\u0bbf\\u0b95\\u0bb5\\u0bc1\\u0bae\\u0bcd \\u0b8f\\u0bb1\\u0bcd\\u0bb1\\u0ba4\\u0bc1.' : 'Excellent for Rice, Sugarcane, and most Vegetables.') :
                    (isTa ? '\\u0baa\\u0bb0\\u0bc1\\u0baa\\u0bcd\\u0baa\\u0bc1 \\u0bb5\\u0b95\\u0bc8\\u0b95\\u0bb3\\u0bc8 \\u0baa\\u0baf\\u0bbf\\u0bb0\\u0bbf\\u0b9f\\u0bc1\\u0bb5\\u0ba4\\u0ba9\\u0bcd \\u0bae\\u0bc2\\u0bb2\\u0bae\\u0bcd \\u0bae\\u0ba3\\u0bcd \\u0bb5\\u0bb3\\u0ba4\\u0bcd\\u0ba4\\u0bc8 \\u0bae\\u0bc7\\u0bae\\u0bcd\\u0baa\\u0b9f\\u0bc1\\u0ba4\\u0bcd\\u0ba4\\u0bb2\\u0bbe\\u0bae\\u0bcd.' : 'Consider pulses to improve soil texture and health.'),`;

    fs.writeFileSync('server.js', before + replacement + after);
    console.log("Fixed successfully!");
} else {
    console.log("Could not find the target text.");
}
