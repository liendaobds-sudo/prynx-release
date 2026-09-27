// PERF (audit 2026-09-27 §V27.01): kiểm hợp đồng JSX thật, không dựng bản caller giả.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('AcrobatViewer — nguồn frame PPE mồi', () => {
    it('truyền path của file đang render, không dùng nguồn selection cũ', () => {
        const source = readFileSync(new URL('./AcrobatViewer.tsx', import.meta.url), 'utf8');
        const ast = ts.createSourceFile('AcrobatViewer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const expressions: string[] = [];
        const visit = (node: ts.Node) => {
            if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'LivePageFrame') {
                const attr = node.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText(ast) === 'nativeFilePath');
                expect(attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer)).toBeTruthy();
                if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer)) {
                    expressions.push(attr.initializer.expression!.getText(ast));
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(ast);
        expect(expressions).toHaveLength(1);
        const code = ts.transpileModule(`return (${expressions[0]});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        const resolve = new Function('file', code) as (file: { path?: string } | null) => string | null;
        expect(resolve({ path: 'D:/working/revision-2.pdf' })).toBe('D:/working/revision-2.pdf');
        expect(resolve({ path: 'D:/working/revision-3.pdf' })).toBe('D:/working/revision-3.pdf');
        expect(resolve({})).toBeNull();
        expect(resolve(null)).toBeNull();
    });
});
