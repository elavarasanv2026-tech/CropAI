const fs = require('fs');
const content = fs.readFileSync('./server.js', 'utf8');
const lines = content.split('\n');

console.log('Total lines:', lines.length);

// Find the line with `'Tomato': {` that's the duplicate (second occurrence after Potato)
let potatoIdx = -1;
let tomatoDupIdx = -1;
let cropDataCloseIdx = -1;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "'Potato': {" && potatoIdx === -1) potatoIdx = i;
    if (potatoIdx > 0 && line === "'Tomato': {" && i > potatoIdx) {
        tomatoDupIdx = i;
        break;
    }
}

if (tomatoDupIdx === -1) {
    console.log('No duplicate Tomato block found. File may already be fixed.');
    process.exit(0);
}

console.log('Potato block starts at line:', potatoIdx + 1);
console.log('Duplicate Tomato block starts at line:', tomatoDupIdx + 1);

// Find the closing of the Potato block (it should be the `}` right before Tomato dup)
// The duplicate Tomato block ends at some point. Let's find where it ends
// The Potato block ends with:   } (closing the block)
// then the cropData closes with }; 
// We need to find the end of the duplicate Tomato section

// Find the closing `}` for the duplicate block
let depth = 0;
let dupEndIdx = -1;
for (let i = tomatoDupIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
    }
    if (depth <= 0 && i > tomatoDupIdx) {
        dupEndIdx = i;
        break;
    }
}

console.log('Duplicate block ends at line:', dupEndIdx + 1);
console.log('Line content at end:', lines[dupEndIdx]);

// Remove lines from tomatoDupIdx to dupEndIdx (inclusive), excluding the line before that might have a trailing comma
// The line before is the Potato block close: `        }` or `        },`
// After removing the dup block, update the Potato close to `        }` (without comma if nothing follows)

// Actually let's look at context
const lineBeforeTomatoDup = lines[tomatoDupIdx - 1];
console.log('Line before duplicate Tomato block (should be comma):', JSON.stringify(lineBeforeTomatoDup));
console.log('Line after dup block end:', JSON.stringify(lines[dupEndIdx + 1]));

// Remove the duplicate block including the trailing comma before it if present
let startRemove = tomatoDupIdx;
// If line before starts the duplicate and has a comma on the previous line, remove that comma too
if (lineBeforeTomatoDup.trim() === '},') {
    // Keep the `},` but change it to `}` since Tomato is being removed
    // Actually we need to check if cropData still has items after the Potato block
    // After removing Tomato (dup), line after dupEnd should be `    };` (closing cropData)
    // So Potato should close with `}` not `},`
    // Let's change the line before to have no comma:
    lines[tomatoDupIdx - 1] = lineBeforeTomatoDup.replace('},', '}');
}

// Remove lines from tomatoDupIdx to dupEndIdx
lines.splice(tomatoDupIdx, dupEndIdx - tomatoDupIdx + 1);

console.log('After fix, total lines:', lines.length);

fs.writeFileSync('./server.js', lines.join('\n'), 'utf8');
console.log('Fixed! Saved server.js');
