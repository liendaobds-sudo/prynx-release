// COLOR (audit 2026-09-28 §KNOCK.V1): kiểm wiring thật và ranh giới xem/proof.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { resolveViewerPageColorMode, type PpeUnsupportedStatus } from '../hooks/viewer/useTileRenderer';

function viewerAst() {
    const source = readFileSync(new URL('./AcrobatViewer.tsx', import.meta.url), 'utf8');
    return ts.createSourceFile('AcrobatViewer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function findInitializer(ast: ts.SourceFile, name: string): ts.Expression | undefined {
    let found: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    return found;
}

describe('AcrobatViewer — trang tương thích không giả là proof', () => {
    it('quyết định theo trang nguồn và giữ Output Preview là yêu cầu strict', () => {
        const ast = viewerAst();
        const decision = findInitializer(ast, 'pageColorMode');
        expect(decision, 'Viewer phải dùng cùng policy với renderer cho mỗi trang').toBeDefined();
        expect(decision!.getText(ast)).toContain('resolveViewerPageColorMode');
        expect(decision!.getText(ast)).toContain('getPpeUnsupportedStatus(originalPageNum)');
        expect(decision!.getText(ast)).toContain('strictProofRequired: strictViewerProofRequired');
        const evaluate = new Function(
            'resolveViewerPageColorMode', 'viewerEngineMode', 'accurateColorEnabled',
            'accurateColorPages', 'originalPageNum', 'strictViewerProofRequired', 'getPpeUnsupportedStatus',
            ts.transpileModule(`return (${decision!.getText(ast)});`, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        ) as (
            resolver: typeof resolveViewerPageColorMode, mode: 'current' | 'hybrid' | 'ppe-only',
            enabled: boolean, pages: number[], page: number, proof: boolean,
            getStatus: (page: number) => PpeUnsupportedStatus | null,
        ) => ReturnType<typeof resolveViewerPageColorMode>;
        const unsupported = { reason: 'knockout_transparency', detail: 'Knockout chưa hỗ trợ.' };
        const getStatus = (page: number) => page === 1 ? unsupported : null;
        expect(evaluate(resolveViewerPageColorMode, 'current', true, [1, 2], 1, false, getStatus))
            .toEqual({ accurateColorPage: false, compatibility: unsupported });
        expect(evaluate(resolveViewerPageColorMode, 'current', true, [1, 2], 2, false, getStatus))
            .toEqual({ accurateColorPage: true, compatibility: null });
        for (const mode of ['current', 'hybrid', 'ppe-only'] as const) {
            expect(evaluate(resolveViewerPageColorMode, mode, true, [1], 1, true, getStatus))
                .toEqual({ accurateColorPage: true, compatibility: null });
        }
    });

    it('CMYK bật bằng tay và Output Preview không bị hạ xuống xem tương thích', () => {
        const ast = viewerAst();
        const strict = findInitializer(ast, 'strictViewerProofRequired');
        expect(strict).toBeDefined();
        const evaluate = new Function('showOutputPreview', 'accurateColorPreference', 'accurateColorSourceKey',
            `return (${strict!.getText(ast)});`) as (
                proof: boolean, preference: { sourceKey: string; enabled: boolean } | null, key: string,
            ) => boolean;
        expect(evaluate(false, null, 'file-A')).toBe(false);
        expect(evaluate(true, null, 'file-A')).toBe(true);
        expect(evaluate(false, { sourceKey: 'file-A', enabled: true }, 'file-A')).toBe(true);
        expect(evaluate(false, { sourceKey: 'file-A', enabled: false }, 'file-A')).toBe(false);
        expect(evaluate(false, { sourceKey: 'file-A', enabled: true }, 'file-B')).toBe(false);
    });

    it('đổi cả LivePageFrame khi chuyển compatibility, không giữ tile PPE cũ', () => {
        const ast = viewerAst();
        const keys: string[] = [];
        const visit = (node: ts.Node) => {
            if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'LivePageFrame') {
                const key = node.attributes.properties.find(attribute => (
                    ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'key'
                ));
                if (key) keys.push(key.getText(ast));
            }
            ts.forEachChild(node, visit);
        };
        visit(ast);
        expect(keys).toHaveLength(1);
        expect(keys[0]).toContain('pageColorMode.compatibility');
        expect(keys[0]).toContain('renderedPageInstanceId');
    });

    it('cảnh báo nằm ở đúng trang, không chỉ ẩn trong tooltip CMYK', () => {
        const source = viewerAst().text;
        expect(source.includes('data-testid="viewer-page-compatibility"')).toBe(true);
        expect(source.includes('data-page={originalPageNum}')).toBe(true);
        expect(source.includes('Không dùng để duyệt màu in.')).toBe(true);
        expect(source.includes('activePageColorMode.compatibility')).toBe(true);
        expect(source.includes("CMYK{accurateColorError || activePpeUnsupported ? '!'" )).toBe(true);
    });

    it('thay capability/Output Preview buộc row ảo hóa cập nhật, không chờ zoom', () => {
        const ast = viewerAst();
        const initializer = findInitializer(ast, 'virtuosoPresentationRevision');
        expect(initializer && ts.isCallExpression(initializer)).toBe(true);
        if (!initializer || !ts.isCallExpression(initializer)) throw new Error('Thiếu revision trình bày.');
        expect(initializer.arguments).toHaveLength(2);
        const inputs = initializer.arguments[0].getText(ast);
        const dependencies = initializer.arguments[1].getText(ast);
        for (const name of ['getPpeUnsupportedStatus', 'showOutputPreview', 'strictViewerProofRequired']) {
            expect(inputs.includes(name)).toBe(true);
            expect(dependencies.includes(name)).toBe(true);
        }
    });
});
