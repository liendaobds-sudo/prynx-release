#!/usr/bin/env node
// Phân loại chuỗi BỎ QUA (no-component-scope) theo NGỮ CẢNH thật để quyết cách xử lý.
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

const fileMap = new Map();
for (const [ns, keys] of Object.entries(keymap))
  for (const [key, info] of Object.entries(keys))
    for (const f of info.files) {
      const rel = norm(f);
      if (!fileMap.has(rel)) fileMap.set(rel, { ns, byVi: new Map() });
      fileMap.get(rel).byVi.set(info.vi, `${ns}:${key}`);
    }

function isComp(node) {
  let name;
  if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
  else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) name = node.parent.name.text;
  else if (ts.isFunctionExpression(node) && node.name) name = node.name.text;
  if (!name) return false;
  return /^[A-Z]/.test(name) || /^use[A-Z]/.test(name);
}
function findBody(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) {
      if (isComp(cur) && cur.body && ts.isBlock(cur.body)) return cur.body;
    }
    cur = cur.parent;
  }
  return null;
}
// Có nằm trong BẤT KỲ function nào (kể cả non-component) không?
function inAnyFn(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

const cats = {};
const byFileKind = {}; // rel -> count (chỉ module-const thuần)
for (const [rel, { byVi }] of fileMap) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) {
      const v = ts.isJsxText(node) ? node.getFullText(sf).trim() : node.text;
      if (v && byVi.has(v) && !findBody(node)) {
        let ctx;
        if (inAnyFn(node)) ctx = 'non-component-fn'; // trong lib helper / callback
        else if (rel.endsWith('.ts') && !rel.endsWith('.tsx')) ctx = 'ts-module-const';
        else ctx = 'tsx-module-const';
        cats[ctx] = (cats[ctx] || 0) + 1;
        byFileKind[rel] = (byFileKind[rel] || 0) + 1;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}
console.log('SKIPPED theo ngữ cảnh:');
console.log(JSON.stringify(cats, null, 2));
console.log('\nTOP 25 FILE:');
for (const [rel, c] of Object.entries(byFileKind).sort((a, b) => b[1] - a[1]).slice(0, 25))
  console.log(`  ${String(c).padStart(4)}  ${rel}`);
