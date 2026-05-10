// Embeds assets/logo.jpg as a base64 string into worker/src/logo.js
// Run before deploying: node build-logo.js
const fs   = require('fs');
const path = require('path');

const logoPath   = path.join(__dirname, '..', 'assets', 'logo.jpg');
const outputPath = path.join(__dirname, 'src', 'logo.js');

let base64 = '';
if (fs.existsSync(logoPath)) {
  base64 = fs.readFileSync(logoPath).toString('base64');
  console.log('Logo embedded (' + Math.round(base64.length / 1024) + ' KB base64).');
} else {
  console.warn('Warning: assets/logo.jpg not found — document will render without logo.');
}

fs.writeFileSync(outputPath, `export const LOGO_BASE64 = '${base64}';\n`);
