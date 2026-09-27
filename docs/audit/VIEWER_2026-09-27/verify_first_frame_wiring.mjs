// PERF (audit 2026-09-27): probe hợp đồng nối frame mồi; chỉ đọc source,
// không render PDF, không thay source sản phẩm và không tự nhận bằng chứng GUI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '../../../desktop/node_modules/typescript/lib/typescript.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const paths = {
  caller: 'desktop/src/components/AcrobatViewer.tsx',
  consumer: 'desktop/src/components/workspace/LivePageFrame.tsx',
  store: 'desktop/src/lib/viewerFirstFrame.ts',
};
const files = Object.fromEntries(Object.entries(paths).map(([key, path]) => {
  const text = readFileSync(resolve(repo, path), 'utf8');
  return [key, {
    path, text, sha256: createHash('sha256').update(text).digest('hex'),
    ast: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  }];
}));
function collect(ast, predicate) {
  const found = [];
  const visit = (node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}
function line(file, node) {
  return file.ast.getLineAndCharacterOfPosition(node.getStart(file.ast)).line + 1;
}
function javascript(text) {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const calls = collect(files.caller.ast, node => (
  (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
  && node.tagName.getText(files.caller.ast) === 'LivePageFrame'
));
assert.equal(calls.length, 1, 'Probe cần cập nhật nếu số caller thay đổi.');
const attributes = calls[0].attributes.properties.map(attribute => (
  ts.isJsxAttribute(attribute) ? attribute.name.getText(files.caller.ast) : 'SPREAD'
));
assert.equal(attributes.includes('SPREAD'), false,
  'Không được kết luận thiếu prop khi caller dùng spread chưa phân giải.');

const primeDeclaration = collect(files.consumer.ast, node => (
  ts.isVariableDeclaration(node) && node.name.getText(files.consumer.ast) === 'primePath'
))[0];
assert.ok(primeDeclaration?.initializer, 'Không tìm thấy policy primePath thật.');
const names = ['accurateColorPage', 'originalPageNum', 'rotation',
  'accurateColorProfileId', 'accurateColorIntent', 'accurateColorProofIdentity', 'nativeFilePath'];
const policy = new Function(...names, javascript(
  `return (${primeDeclaration.initializer.getText(files.consumer.ast)});`,
));
const peekDeclaration = collect(files.store.ast, node => (
  ts.isFunctionDeclaration(node) && node.name?.text === 'peekViewerFirstFrame'
))[0];
assert.ok(peekDeclaration, 'Không tìm thấy consumer kho frame thật.');
const peekSource = peekDeclaration.getText(files.store.ast).replace(/^export\s+/, '');
const peek = new Function('framesByPath', 'normalizedPath',
  javascript(`${peekSource}\nreturn peekViewerFirstFrame;`));

// Đối chứng dương: dùng chính policy/store từ source; frame có sẵn và token khớp.
const fixturePath = 'D:\\pdfcompare\\test\\CMNM2026 - Giay moi_BLUE - in_OUTLINE_FONTS_5e2846.pdf';
const token = 'audit-wiring-fixture-token';
const frame = { nativePath: fixturePath, documentToken: token, page: 1, url: 'audit:ppe-frame' };
const stored = new Map([[fixturePath.toLowerCase(), frame]]);
const readFrame = peek(stored, path => path.toLowerCase());
const args = [true, 1, 0, 'fogra39', 'relative', 'show:all|paper:0|black:0|background:profile'];
const positivePrimePath = policy(...args, fixturePath);
assert.equal(readFrame(positivePrimePath, token), frame,
  'Đối chứng dương phải đọc được frame từ chính policy/store.');

// JSX không truyền nativeFilePath và không có spread => React prop là undefined.
const hasNativeFilePath = attributes.includes('nativeFilePath');
const actualPrimePath = policy(...args, hasNativeFilePath ? fixturePath : undefined);
const actualFrame = readFrame(actualPrimePath, token);
const result = {
  evidenceKind: 'source_ast_and_extracted_policy_contract',
  runtimeAcceptance: 'NOT_TESTED',
  pdfRendered: false,
  source: Object.fromEntries(Object.entries(files).map(([key, file]) => (
    [key, { path: file.path, sha256: file.sha256 }]
  ))),
  caller: { line: line(files.caller, calls[0]), hasNativeFilePath, hasSpread: false, attributes },
  consumer: { primePathLine: line(files.consumer, primeDeclaration),
    peekLine: line(files.store, peekDeclaration) },
  positiveControlReadsPreparedFrame: true,
  actualPrimePath: actualPrimePath ?? null,
  actualReadsPreparedFrame: actualFrame === frame,
  contractPassed: actualFrame === frame,
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.contractPassed ? 0 : 1;
