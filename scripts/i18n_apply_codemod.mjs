#!/usr/bin/env node
/**
 * i18n codemod — thay chuỗi VN hardcode bằng t('ns:key').
 *
 * AN TOÀN:
 *   • Dùng TypeScript AST để ĐỊNH VỊ node (StringLiteral / JsxText), KHÔNG dùng printer
 *     (printer reformat cả file). Thay bằng text-splice theo offset từ CUỐI về ĐẦU
 *     → giữ nguyên 100% format, chỉ đụng đúng đoạn thay.
 *   • CHỈ thay khi text khớp BYTE-FOR-BYTE với vi trong keymap (đảo từ i18n_keymap.json).
 *   • CHỈ thay khi tìm được component/hook để đặt `const { t } = useTranslation()`.
 *     Chuỗi trong helper thường (lib/, callback rời) → BỎ QUA, ghi danh sách sửa tay.
 *   • Idempotent: bỏ qua node đã là t(...).
 *
 * Chạy (từ repo root):
 *   node scripts/i18n_apply_codemod.mjs --ns misc.themeToggle --dry
 *   node scripts/i18n_apply_codemod.mjs --ns misc.themeToggle --write
 *   node scripts/i18n_apply_codemod.mjs --file desktop/src/components/ThemeToggle.tsx --dry
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// typescript nằm trong desktop/node_modules
const require = createRequire(path.join(ROOT, 'desktop', 'package.json'));
const ts = require('typescript');

// ─── args ───
const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = argv.includes('--dry');
const WRITE = argv.includes('--write');
const nsFilter = getArg('--ns');
const fileFilter = getArg('--file');

if (!DRY && !WRITE) {
  console.error('Phải chọn --dry (xem trước) hoặc --write (ghi thật).');
  process.exit(1);
}

// ─── keymap → fileMap ───
// keymap: { ns: { key: { vi, files:[...], kind } } }
// fileMap: normRelPath -> { ns, byVi: Map(vi -> key) }
const keymap = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'i18n_keymap.json'), 'utf8'));
const norm = (p) => p.replace(/\\/g, '/');

const fileMap = new Map();
for (const [ns, keys] of Object.entries(keymap)) {
  if (nsFilter && ns !== nsFilter) continue;
  for (const [key, info] of Object.entries(keys)) {
    for (const f of info.files) {
      const rel = norm(f);
      if (!fileMap.has(rel)) fileMap.set(rel, { ns, byVi: new Map() });
      fileMap.get(rel).byVi.set(info.vi, `${ns}:${key}`);
    }
  }
}

let targetFiles = [...fileMap.keys()];
if (fileFilter) {
  const nf = norm(fileFilter);
  targetFiles = targetFiles.filter((f) => f === nf);
}

// ─── helpers AST ───
function isComponentLike(node) {
  // FunctionDeclaration / FunctionExpression: tên viết hoa hoặc bắt đầu 'use'
  // ArrowFunction/FunctionExpression gán cho biến viết hoa/'use…'
  let name;
  if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
  else if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.parent &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    name = node.parent.name.text;
  } else if (ts.isFunctionExpression(node) && node.name) name = node.name.text;
  if (!name) return false;
  return /^[A-Z]/.test(name) || /^use[A-Z]/.test(name);
}

function findComponentBody(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur)
    ) {
      if (isComponentLike(cur) && cur.body && ts.isBlock(cur.body)) return cur.body;
      // function không phải component → không đặt hook ở đây, đi tiếp lên trên
    }
    cur = cur.parent;
  }
  return null;
}

function alreadyT(node) {
  // node nằm trong lời gọi t(...) rồi?
  let cur = node.parent;
  while (cur) {
    if (
      ts.isCallExpression(cur) &&
      ts.isIdentifier(cur.expression) &&
      cur.expression.text === 't'
    )
      return true;
    cur = cur.parent;
  }
  return false;
}

// Vị trí mà đổi ngôn ngữ sẽ PHÁ LOGIC (tsc KHÔNG bắt được vì cả 2 vế đều string):
//   - so sánh: x === 'Liên Tục'  → sau dịch, t() trả EN còn giá trị lưu là VN → sai
//   - case 'Bìa Trước':          → discriminant, so khớp vỡ
//   - key object / element access: obj['Chất liệu'], { 'Chất liệu': ... } (tên key)
//   - switch(expr) chính expr
// → literal ở các chỗ này KHÔNG phải text hiển thị, phải BỎ QUA.
const CMP_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
function isUnsafeContext(node) {
  const p = node.parent;
  if (!p) return false;
  // so sánh nhị phân
  if (ts.isBinaryExpression(p) && CMP_OPS.has(p.operatorToken.kind)) return true;
  // case 'literal':
  if (ts.isCaseClause(p)) return true;
  // tên property trong object literal / khai báo: { 'literal': ... }
  if (
    (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isEnumMember(p)) &&
    p.name === node
  )
    return true;
  // obj['literal'] — element access (đọc/ghi theo key)
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  // computed property name [ 'literal' ]
  if (ts.isComputedPropertyName(p)) return true;
  // arg của includes/indexOf/startsWith/endsWith/has/get/... (so khớp, không hiển thị)
  if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression)) {
    const m = p.expression.name.text;
    if (/^(includes|indexOf|lastIndexOf|startsWith|endsWith|has|get|delete|localeCompare)$/.test(m))
      return true;
  }
  return false;
}

// ─── xử lý 1 file ───
function processFile(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  const src = fs.readFileSync(abs, 'utf8');
  const { byVi } = fileMap.get(rel);
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const edits = []; // {start, end, text}
  const bodiesToInject = new Set(); // Block nodes
  const skipped = []; // chuỗi khớp nhưng không đặt được hook

  function visit(node) {
    // String literal
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const val = node.text;
      if (byVi.has(val) && !alreadyT(node)) {
        const keyRef = byVi.get(val);
        if (isUnsafeContext(node)) {
          skipped.push({ vi: val, reason: 'unsafe-context' });
          return;
        }
        const body = findComponentBody(node);
        if (!body) {
          skipped.push({ vi: val, reason: 'no-component-scope' });
        } else {
          // JSX attribute value: title="..." → phải bọc {t(...)} (không thể để t(...) trần).
          const inJsxAttr = node.parent && ts.isJsxAttribute(node.parent) && node.parent.initializer === node;
          edits.push({
            start: node.getStart(sf),
            end: node.getEnd(),
            text: inJsxAttr ? `{t('${keyRef}')}` : `t('${keyRef}')`,
          });
          bodiesToInject.add(body);
        }
      }
      return;
    }
    // JSX text
    if (ts.isJsxText(node)) {
      const full = node.getFullText(sf);
      const trimmed = full.trim();
      if (trimmed && byVi.has(trimmed) && !alreadyT(node)) {
        const keyRef = byVi.get(trimmed);
        const body = findComponentBody(node);
        if (!body) {
          skipped.push({ vi: trimmed, reason: 'no-component-scope' });
        } else {
          const fullStart = node.getFullStart();
          const idx = full.indexOf(trimmed);
          const start = fullStart + idx;
          const end = start + trimmed.length;
          edits.push({ start, end, text: `{t('${keyRef}')}` });
          bodiesToInject.add(body);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (edits.length === 0) return { rel, changed: false, skipped };

  // Chèn hook vào mỗi component body (nếu chưa có)
  for (const body of bodiesToInject) {
    const bodyText = body.getText(sf);
    if (/\buseTranslation\s*\(/.test(bodyText) || /const\s*\{\s*t\s*[},]/.test(bodyText)) continue;
    const insertPos = body.getStart(sf) + 1; // ngay sau '{'
    edits.push({ start: insertPos, end: insertPos, text: `\n  const { t } = useTranslation();` });
  }

  // Chèn import nếu chưa có
  if (!/from ['"]react-i18next['"]/.test(src)) {
    const imports = sf.statements.filter((s) => ts.isImportDeclaration(s));
    const anchor = imports.length ? imports[imports.length - 1] : null;
    const pos = anchor ? anchor.getEnd() : 0;
    const stmt = `\nimport { useTranslation } from 'react-i18next';`;
    edits.push({ start: pos, end: pos, text: anchor ? stmt : stmt.trimStart() + '\n' });
  }

  // Apply từ CUỐI về ĐẦU
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  return { rel, changed: out !== src, before: src, after: out, skipped, nEdits: edits.length };
}

// ─── run ───
let totalChanged = 0;
const allSkipped = [];
for (const rel of targetFiles) {
  const r = processFile(rel);
  if (!r) continue;
  if (r.skipped?.length) allSkipped.push({ rel, items: r.skipped });
  if (!r.changed) continue;
  totalChanged++;
  if (DRY) {
    console.log(`\n===== ${rel}  (${r.nEdits} edits) =====`);
    // diff thô: in các dòng khác nhau
    const a = r.before.split('\n');
    const b = r.after.split('\n');
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (a[i] !== b[i]) {
        if (a[i] !== undefined) console.log(`  - ${a[i]}`);
        if (b[i] !== undefined) console.log(`  + ${b[i]}`);
      }
    }
  } else if (WRITE) {
    fs.writeFileSync(path.join(ROOT, rel), r.after, 'utf8');
    console.log(`  ✓ ${rel}  (${r.nEdits} edits)`);
  }
}

console.log(`\n─────────────────────────────`);
console.log(`  File đổi: ${totalChanged}`);
if (allSkipped.length) {
  const n = allSkipped.reduce((s, x) => s + x.items.length, 0);
  console.log(`  Chuỗi BỎ QUA (sửa tay): ${n} ở ${allSkipped.length} file`);
  for (const s of allSkipped.slice(0, 20)) {
    console.log(`    ${s.rel}`);
    for (const it of s.items.slice(0, 5)) console.log(`      • [${it.reason}] ${it.vi.slice(0, 60)}`);
  }
}
