// Kiểm cú pháp nhanh 1 hoặc nhiều file TS/TSX bằng oxc transform của Vite 7.
// Dùng: node parsecheck.mjs src/App.tsx src/lib/api.ts
import { transformWithOxc } from 'vite';
import { readFileSync } from 'node:fs';
let bad = 0;
for (const file of process.argv.slice(2)) {
  try {
    await transformWithOxc(readFileSync(file, 'utf8'), file);
    console.log('OK       ' + file);
  } catch (e) {
    bad++;
    console.error('FAIL     ' + file + '\n' + (e.message || e));
  }
}
process.exit(bad ? 1 : 0);
