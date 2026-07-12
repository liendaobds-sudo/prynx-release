#!/usr/bin/env node
/**
 * Phân tích SÂU nhóm skipped (no-component-scope) — sau khi đã xử lý catalog.
 * Mục tiêu: phân loại theo LOẠI FILE + MẪU NGỮ CẢNH để quyết cụm nào đáng wrap tv().
 *
 * Chạy từ desktop/:  node ../scripts/i18n_analyze_skipped2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(path.join(ROOT, 'desktop', 'package.json'));
const ts = require('typescript');

const keymap = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'i18n_keymap.json'), 'utf8'));
const norm = (p) => p.replace(/\\/g, '/');

// file -> Set(vi strings) từ keymap
const fileVi = new Map();
for (const [, keys] of Object.entries(keymap)) {
  for (const [, info] of Object.entries(keys)) {
    for (const f of info.files) {
      const rel = norm(f);
      if (!fileVi.has(rel)) fileVi.set(rel, new Set());
      fileVi.get(rel).add(info.vi);
    }
  }
}

// Phân loại 1 chuỗi VN trong 1 file theo ngữ cảnh AST
function classify(abs, viSet) {
  const src = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const buckets = { alreadyDone: 0, moduleConstData: 0, nonCompFn: 0, jsxOrAttr: 0, other: 0 };
  const samples = { moduleConstData: [], nonCompFn: [], other: [] };

  function inComponent(node) {
    let cur = node.parent;
    while (cur) {
      if (ts.isFunctionDeclaration(cur) || ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
        let name;
        if (ts.isFunctionDeclaration(cur) && cur.name) name = cur.name.text;
        else if (cur.parent && ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) name = cur.parent.name.text;
        if (name && (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name))) return 'component';
        return 'fn';
      }
      cur = cur.parent;
    }
    return 'module';
  }
  function inTfn(node) {
    let cur = node.parent;
    while (cur) {
      if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && (cur.expression.text === 't' || cur.expression.text === 'tv')) return true;
      cur = cur.parent;
    }
    return false;
  }

  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const v = node.text;
      if (viSet.has(v)) {
        if (inTfn(node)) { buckets.alreadyDone++; return; }
        const scope = inComponent(node);
        // JSX attribute / JSX text trong component
        if (scope === 'component') { buckets.jsxOrAttr++; }
        else if (scope === 'module') { buckets.moduleConstData++; if (samples.moduleConstData.length < 3) samples.moduleConstData.push(v.slice(0, 45)); }
        else { buckets.nonCompFn++; if (samples.nonCompFn.length < 3) samples.nonCompFn.push(v.slice(0, 45)); }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { buckets, samples };
}

const rows = [];
for (const [rel, viSet] of fileVi) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const { buckets, samples } = classify(abs, viSet);
  const pending = buckets.moduleConstData + buckets.nonCompFn;
  if (pending > 0) rows.push({ rel, ...buckets, pending, samples });
}
rows.sort((a, b) => b.pending - a.pending);

let totalMod = 0, totalFn = 0;
for (const r of rows) { totalMod += r.moduleConstData; totalFn += r.nonCompFn; }
console.log(`TỔNG còn lại (chưa qua t/tv): moduleConstData=${totalMod}  nonCompFn=${totalFn}  → ${totalMod + totalFn}`);
console.log(`\nTOP 25 FILE (pending = moduleConstData + nonCompFn):`);
for (const r of rows.slice(0, 25)) {
  console.log(`  ${String(r.pending).padStart(4)}  ${r.rel}   [mod=${r.moduleConstData} fn=${r.nonCompFn} done=${r.alreadyDone}]`);
}
