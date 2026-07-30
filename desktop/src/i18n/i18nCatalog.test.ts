import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import enLocale from './locales/en.json';
import viLocale from './locales/vi.json';
import { BOX_GROUPS, BOX_VARIANTS } from '../lib/dieline/variants';

type LocaleCatalog = Record<string, Record<string, unknown>>;

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const HTML_ENTITY_PATTERN = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/i;

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name)) || TEST_FILE_PATTERN.test(entry.name)) return [];
    return [fullPath];
  });
}

function collectStaticTranslationKeys(): Set<string> {
  const keys = new Set<string>();
  for (const filePath of listSourceFiles(SOURCE_ROOT)) {
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const isTranslationCall =
          (ts.isIdentifier(node.expression) && node.expression.text === 't') ||
          (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't');
        const firstArgument = node.arguments[0];
        if (isTranslationCall && firstArgument && ts.isStringLiteralLike(firstArgument) && firstArgument.text.includes(':')) {
          keys.add(firstArgument.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return keys;
}

function hasTranslation(locale: LocaleCatalog, fullKey: string): boolean {
  const separator = fullKey.indexOf(':');
  const namespace = fullKey.slice(0, separator);
  const key = fullKey.slice(separator + 1);
  return typeof locale[namespace]?.[key] === 'string';
}

function collectEntityPaths(value: unknown, currentPath = ''): string[] {
  if (typeof value === 'string') return HTML_ENTITY_PATTERN.test(value) ? [currentPath] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    collectEntityPaths(child, currentPath ? `${currentPath}.${key}` : key),
  );
}

describe('danh mục i18n', () => {
  // Timeout tường minh: test này parse AST của TOÀN BỘ source nên chi phí tăng theo
  // số tệp — chạy riêng ~0,9s nhưng khi cả bộ test chạy song song có lúc vượt mốc
  // 5s mặc định và đỏ oan. [VARIANT 2026-07-29]
  it('mọi khóa tĩnh đang dùng đều có cả tiếng Việt và tiếng Anh', () => {
    const staticKeys = collectStaticTranslationKeys();
    expect(staticKeys.size).toBeGreaterThan(1_000);
    expect([...staticKeys].filter((key) => !hasTranslation(viLocale, key)).sort()).toEqual([]);
    expect([...staticKeys].filter((key) => !hasTranslation(enLocale, key)).sort()).toEqual([]);
  }, 60_000);

  // [VARIANT 2026-07-29] Tên/mô tả biến thể khuôn bế được dịch qua `tv()` (tra
  // NGƯỢC từ chuỗi tiếng Việt trong catalog), nên chúng KHÔNG xuất hiện dưới dạng
  // khoá tĩnh `t('ns:key')` và không được test ở trên bảo vệ. Kiểm riêng ở đây.
  it('mọi biến thể và nhóm khuôn bế đều có bản dịch VI + EN', () => {
    const ns = 'dieline.variant';
    const viStrings = new Set(Object.values((viLocale as LocaleCatalog)[ns] ?? {}));
    const missingVi: string[] = [];
    for (const v of BOX_VARIANTS) {
      if (!viStrings.has(v.nameVi)) missingVi.push(`${v.code} name`);
      if (!viStrings.has(v.descVi)) missingVi.push(`${v.code} desc`);
    }
    for (const g of BOX_GROUPS) {
      if (!viStrings.has(g.nameVi)) missingVi.push(`group ${g.id}`);
    }
    expect(missingVi).toEqual([]);

    // Mọi khoá của namespace phải có bản EN (không rỗng) — nếu thiếu, i18next
    // fallback về VI và người dùng bản Anh thấy tiếng Việt lẫn vào.
    const enNs = (enLocale as LocaleCatalog)[ns] ?? {};
    const missingEn = Object.keys((viLocale as LocaleCatalog)[ns] ?? {})
      .filter((key) => typeof enNs[key] !== 'string' || !enNs[key])
      .sort();
    expect(missingEn).toEqual([]);
  });

  it('locale không chứa HTML entity bị hiển thị nguyên văn', () => {
    expect(collectEntityPaths(viLocale)).toEqual([]);
    expect(collectEntityPaths(enLocale)).toEqual([]);
  });
});
