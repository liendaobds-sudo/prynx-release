const fs = require('fs');
let svg = fs.readFileSync('public/favicon.svg', 'utf8');
svg = svg.replace(/width="48" height="46"/, 'width="1024" height="1024"');
svg = svg.replace(/viewBox="0 0 48 46"/, 'viewBox="0 -1 48 48"');
svg = svg.replace(/fill:color\([^)]+\);/g, '');
fs.writeFileSync('public/logo.svg', svg);
console.log('Fixed SVG saved to logo.svg');
