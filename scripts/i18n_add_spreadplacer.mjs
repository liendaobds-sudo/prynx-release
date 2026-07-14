import fs from 'node:fs';
const VI = 'desktop/src/i18n/locales/vi.json', EN = 'desktop/src/i18n/locales/en.json';
const vi = JSON.parse(fs.readFileSync(VI, 'utf8')), en = JSON.parse(fs.readFileSync(EN, 'utf8'));
const add = (ns, k, v, e) => {
  vi[ns] = vi[ns] || {}; en[ns] = en[ns] || {};
  if (vi[ns][k] !== undefined && vi[ns][k] !== v) console.warn('WARN differs', ns, k, '->', vi[ns][k]);
  vi[ns][k] = v; en[ns][k] = e;
};
// SpreadPlacer plate label — press-mark baked into PDF; EN MUST start "Plate {{plate}}"
// so processHandlers bilingual regex /^(Kẽm|Plate) \d+/ still renumbers on merge.
add('lib.spreadPlacer', 'base_cover', 'Bìa', 'Cover');
add('lib.spreadPlacer', 'base_pages', '{{n}} trang', '{{n}} pages');
add('lib.spreadPlacer', 'plate_label_ab', 'Kẽm {{plate}} - Tay {{sig}}{{ab}} ({{side}}) - Bài A-B', 'Plate {{plate}} - Sig {{sig}}{{ab}} ({{side}}) - Job A-B');
add('lib.spreadPlacer', 'plate_label_self', 'Kẽm {{plate}} - {{base}} - Tự Trở', 'Plate {{plate}} - {{base}} - Work-and-turn');
add('lib.spreadPlacer', 'side_front', 'Trước', 'Front');
add('lib.spreadPlacer', 'side_back', 'Sau', 'Back');
fs.writeFileSync(VI, JSON.stringify(vi, null, 2) + '\n', 'utf8');
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log('added spreadPlacer keys');
