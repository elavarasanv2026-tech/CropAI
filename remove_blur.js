const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
  let items = fs.readdirSync(dir);
  for (let f of items) {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    if (isDirectory) {
      walkDir(dirPath, callback);
    } else {
      callback(dirPath);
    }
  }
}

const dir = path.join(__dirname, 'public');
walkDir(dir, function(filePath) {
  if (filePath.endsWith('.html') || filePath.endsWith('.css') || filePath.endsWith('.js')) {
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;

    // Remove backdrop-filter rules completely
    content = content.replace(/(webkit-)?backdrop-filter[^;\}]+;?/gi, '');
    
    // Remove "filter: blur(...);" or parts of it
    content = content.replace(/filter\s*:\s*blur\([^)]*\)\s*;?/gi, '');
    // Remove any inline blur() remaining (e.g., from inline styles where we may have only matched part)
    content = content.replace(/blur\([^)]*\)/gi, '');
    
    if (content !== original) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log('Updated: ' + filePath);
    }
  }
});
console.log('Finished removing all blur elements in public directory.');
