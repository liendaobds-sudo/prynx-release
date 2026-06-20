// ============================================================
// Drift Smoke Test — Chống trùng lặp mã (Requirement 4.1–4.4)
//
// Xác minh:
//   1. Shared_Geometry_Module (sharedGeometry.ts) export đầy đủ
//      logic nối chuỗi + công thức kích thước + dẫn xuất legend
//      dùng chung (Requirement 4.1, 4.2).
//   2. Export_Module (exportPDF.ts) import logic đó từ
//      sharedGeometry và KHÔNG định nghĩa cục bộ bản sao
//      buildChains / segEndpoints / chainToSvgD hay công thức
//      FH/SF (Requirement 4.3).
//   3. Canvas_Module (DielineCanvas2D.tsx) import từ
//      sharedGeometry và KHÔNG định nghĩa cục bộ logic nối chuỗi
//      hay công thức kích thước (Requirement 4.4).
//
// Đây là SMOKE test cấu trúc: kiểm tra runtime exports + nội
// dung nguồn tĩnh, không sinh hình học.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sharedGeometry from './sharedGeometry';

/** Đọc nguồn của một file cạnh test này (resolve theo import.meta.url để bền vững với cwd) */
function readSource(relativePath: string): string {
    return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf-8');
}

describe('drift smoke test — Shared_Geometry_Module exports (Requirement 4.1, 4.2)', () => {
    const expectedFns = [
        'ptEq',
        'segEndpoints',
        'buildChains',
        'chainToSvgD',
        'computeEnvelopeDims',
        'deriveLegendTags',
        'assertValidGeometryModel',
    ] as const;

    for (const fn of expectedFns) {
        it(`exports hàm dùng chung: ${fn}`, () => {
            expect(typeof (sharedGeometry as Record<string, unknown>)[fn]).toBe('function');
        });
    }

    it('export hằng số SNAP_TOLERANCE là một số', () => {
        expect(typeof sharedGeometry.SNAP_TOLERANCE).toBe('number');
        expect(sharedGeometry.SNAP_TOLERANCE).toBeGreaterThan(0);
    });
});

describe('drift smoke test — Export_Module dùng lại sharedGeometry (Requirement 4.3)', () => {
    const src = readSource('./exportPDF.ts');

    it('import logic nối chuỗi + công thức kích thước từ ./sharedGeometry', () => {
        // Tìm câu lệnh import từ './sharedGeometry'
        const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/sharedGeometry['"]/);
        expect(importMatch).not.toBeNull();
        const imported = importMatch![1];
        expect(imported).toContain('buildChains');
        expect(imported).toContain('chainToSvgD');
        expect(imported).toContain('computeEnvelopeDims');
    });

    it('KHÔNG định nghĩa cục bộ logic nối chuỗi (buildChains/segEndpoints/chainToSvgD)', () => {
        expect(src).not.toMatch(/function\s+buildChains\b/);
        expect(src).not.toMatch(/function\s+segEndpoints\b/);
        expect(src).not.toMatch(/function\s+chainToSvgD\b/);
    });

    it('KHÔNG định nghĩa cục bộ công thức FH/SF của Envelope', () => {
        // Công thức FH dùng chung là Math.round(flapRef * 0.45) — chỉ được phép
        // tồn tại trong sharedGeometry.computeEnvelopeDims, không lặp ở export.
        expect(src).not.toMatch(/flapRef\s*\*\s*0\.45/);
        expect(src).not.toMatch(/flapRef\s*\*\s*0\.12/);
    });
});

describe('drift smoke test — Canvas_Module dùng lại sharedGeometry (Requirement 4.4)', () => {
    const src = readSource('../../components/dieline-tool/DielineCanvas2D.tsx');

    it('import logic nối chuỗi + công thức + legend từ sharedGeometry', () => {
        const importMatch = src.match(
            /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/sharedGeometry['"]/,
        );
        expect(importMatch).not.toBeNull();
        const imported = importMatch![1];
        expect(imported).toContain('buildChains');
        expect(imported).toContain('chainToSvgD');
        expect(imported).toContain('computeEnvelopeDims');
        expect(imported).toContain('deriveLegendTags');
    });

    it('KHÔNG định nghĩa cục bộ logic nối chuỗi (buildChains/segEndpoints/chainToSvgD)', () => {
        expect(src).not.toMatch(/function\s+buildChains\b/);
        expect(src).not.toMatch(/function\s+segEndpoints\b/);
        expect(src).not.toMatch(/function\s+chainToSvgD\b/);
        // cũng không định nghĩa dưới dạng const arrow
        expect(src).not.toMatch(/const\s+buildChains\s*=/);
        expect(src).not.toMatch(/const\s+chainToSvgD\s*=/);
    });

    it('KHÔNG định nghĩa cục bộ công thức FH/SF của Envelope', () => {
        expect(src).not.toMatch(/flapRef\s*\*\s*0\.45/);
        expect(src).not.toMatch(/flapRef\s*\*\s*0\.12/);
    });
});
