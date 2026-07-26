// ============================================================
// sharedGeometry.test.ts — Property tests cho Shared_Geometry_Module
//
// Property 7 (Task 2.3): Export và Canvas cho đầu ra hình học khớp nhau
//   — Validates: Requirements 4.5
// Property 10 (Task 2.4): Module dùng chung từ chối model không hợp lệ
//   — Validates: Requirements 4.7
//
// Cả Export_Module (exportPDF.ts) và Canvas_Module (DielineCanvas2D.tsx)
// đều dựng chuỗi SVG `d` theo cùng một cách: buildChains(model.allPaths)
// rồi chainToSvgD(chain.segs); và cùng tính FH/SF qua computeEnvelopeDims.
// Vì cùng gọi sharedGeometry nên đầu ra phải khớp ký-tự-theo-ký-tự.
// ============================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    buildChains,
    chainToSvgD,
    computeEnvelopeDims,
    assertValidGeometryModel,
    InvalidDielineModelError,
    SNAP_TOLERANCE,
    EnvelopeDims,
} from './sharedGeometry';
import { arbBoxParams, GeneratorBoxType } from './arbitraries';
import { BoxParams, DielineModel, PathSegment, Point2D } from './types';
import { generateReverseTuckEnd } from './ReverseTuckEnd';
import { generateSnapLockBottom } from './SnapLockBottom';
import { generateAutoBottomBox } from './AutoBottomBox';
import { generateGableBox } from './GableBox';
import { generatePaperBag } from './PaperBag';
import { generateCupSleeve } from './CupSleeve';
import { generatePizzaBox } from './PizzaBox';
import { generateEnvelope } from './Envelope';
import { generateMatchboxTray } from './MatchboxTray';

const ALL_TYPES: GeneratorBoxType[] = [
    'rte', 'slb', 'auto_bottom', 'gable', 'paper_bag', 'cup_sleeve', 'pizza', 'envelope', 'tray',
];

/** Dispatch params → DielineModel (giống dispatchGenerator trong useBoxStore). */
function dispatchGenerator(params: BoxParams): DielineModel {
    switch (params.boxType) {
        case 'slb':
            return generateSnapLockBottom(params);
        case 'auto_bottom':
            return generateAutoBottomBox(params);
        case 'gable':
            return generateGableBox(params);
        case 'paper_bag':
            return generatePaperBag(params);
        case 'cup_sleeve':
            return generateCupSleeve(params);
        case 'pizza':
            return generatePizzaBox(params);
        case 'envelope':
            return generateEnvelope(params);
        case 'tray':
            return generateMatchboxTray(params);
        case 'rte':
        default:
            return generateReverseTuckEnd(params);
    }
}

// ─── Đường đi dựng SVG `d` của Export và Canvas ──────────────
// Hai hàm dưới đây sao lại CÁCH dựng path của mỗi module để so khớp.
// Cả hai đều gọi sharedGeometry (buildChains + chainToSvgD).

/** Cách Export_Module (exportPDF.ts) dựng các chuỗi `d`. */
function exportDStrings(model: DielineModel): string[] {
    const chains = buildChains(model.allPaths);
    return chains.map(chain => chainToSvgD(chain.segs));
}

/** Cách Canvas_Module (DielineCanvas2D.tsx) dựng các chuỗi `d`. */
function canvasDStrings(model: DielineModel): string[] {
    const chains = buildChains(model.allPaths);
    return chains.map(chain => chainToSvgD(chain.segs));
}

/** Cách Export tính kích thước dùng chung. */
function exportDims(params: BoxParams): EnvelopeDims {
    return computeEnvelopeDims(params);
}

/** Cách Canvas tính kích thước dùng chung. */
function canvasDims(params: BoxParams): EnvelopeDims {
    return computeEnvelopeDims(params);
}

// ============================================================
// Property 7 (Task 2.3)
// ============================================================

describe('Property 7: Export và Canvas cho đầu ra hình học khớp nhau', () => {
    // Feature: dieline-hardening, Property 7: For any DielineModel hợp lệ,
    // chuỗi SVG `d` tạo bởi đường đi Export (buildChains + chainToSvgD từ
    // sharedGeometry) giống ký-tự-theo-ký-tự với chuỗi tạo bởi đường đi Canvas,
    // và mọi giá trị ghi chú kích thước dùng chung (ví dụ FH/SF) bằng nhau
    // trong sai số 0.001 mm.
    // Validates: Requirements 4.5

    for (const boxType of ALL_TYPES) {
        it(`Export và Canvas tạo chuỗi SVG d giống ký-tự-theo-ký-tự cho ${boxType}`, () => {
            fc.assert(
                fc.property(arbBoxParams(boxType), (params: BoxParams) => {
                    const model = dispatchGenerator(params);

                    const fromExport = exportDStrings(model);
                    const fromCanvas = canvasDStrings(model);

                    // Cùng số lượng chains
                    expect(fromCanvas.length).toBe(fromExport.length);
                    // Khớp ký-tự-theo-ký-tự từng chuỗi `d`
                    for (let i = 0; i < fromExport.length; i++) {
                        expect(fromCanvas[i]).toBe(fromExport[i]);
                    }
                    // Toàn bộ chuỗi nối lại cũng khớp tuyệt đối
                    expect(fromCanvas.join('|')).toBe(fromExport.join('|'));
                }),
                { numRuns: 100 },
            );
        });
    }

    it('Export và Canvas cho FH/SF bằng nhau trong 0.001mm (envelope)', () => {
        fc.assert(
            fc.property(arbBoxParams('envelope'), (params: BoxParams) => {
                const e = exportDims(params);
                const c = canvasDims(params);
                expect(Math.abs(e.FH - c.FH)).toBeLessThanOrEqual(0.001);
                expect(Math.abs(e.SF - c.SF)).toBeLessThanOrEqual(0.001);
            }),
            { numRuns: 100 },
        );
    });
});

// ============================================================
// Property 10 (Task 2.4)
// ============================================================

/** Dựng một DielineModel tối thiểu bao quanh tập allPaths cho trước. */
function wrapModel(allPaths: PathSegment[], params: BoxParams): DielineModel {
    return {
        name: 'test',
        standardCode: 'TEST',
        description: 'test model',
        panels: [],
        allPaths,
        boundingBox: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
        params,
    };
}

const P = (x: number, y: number): Point2D => ({ x, y });

describe('Property 10: Module dùng chung từ chối model không hợp lệ', () => {
    // Feature: dieline-hardening, Property 10: For any DielineModel không hợp lệ
    // (thiếu segment hoặc chứa chuỗi không khép kín vượt SNAP_TOLERANCE),
    // Shared_Geometry_Module phải báo lỗi cho phía gọi và không trả về chuỗi
    // SVG hay giá trị kích thước một phần.
    // Validates: Requirements 4.7

    /**
     * Bao validate + dựng SVG: nếu model không hợp lệ thì NÉM trước khi sản
     * sinh bất kỳ chuỗi `d` nào → không có đầu ra một phần.
     */
    function buildSvgSafely(model: DielineModel): string[] {
        assertValidGeometryModel(model);
        return buildChains(model.allPaths).map(chain => chainToSvgD(chain.segs));
    }

    it('model thiếu segment (allPaths rỗng) phải ném InvalidDielineModelError', () => {
        fc.assert(
            fc.property(arbBoxParams('rte'), (params: BoxParams) => {
                const model = wrapModel([], params);

                let output: string[] | undefined;
                expect(() => {
                    output = buildSvgSafely(model);
                }).toThrow(InvalidDielineModelError);
                // Không có đầu ra một phần
                expect(output).toBeUndefined();
            }),
            { numRuns: 100 },
        );
    });

    it('model có chuỗi cắt hở vượt SNAP_TOLERANCE phải ném InvalidDielineModelError', () => {
        fc.assert(
            fc.property(
                arbBoxParams('rte'),
                // Khoảng hở luôn lớn hơn SNAP_TOLERANCE (0.01mm)
                fc.double({ min: 1, max: 500, noNaN: true }),
                (params: BoxParams, gap: number) => {
                    // Hình vuông HỞ: thiếu cạnh đóng, điểm cuối cách điểm đầu `gap`
                    const openSquare: PathSegment[] = [
                        { points: [P(0, 0), P(100, 0)], tag: 'CUT', type: 'line' },
                        { points: [P(100, 0), P(100, 100)], tag: 'CUT', type: 'line' },
                        { points: [P(100, 100), P(gap, 100)], tag: 'CUT', type: 'line' },
                        // không quay lại (0,0) → chuỗi hở
                    ];
                    const model = wrapModel(openSquare, params);

                    // Khẳng định khoảng hở thực sự vượt dung sai
                    expect(gap).toBeGreaterThan(SNAP_TOLERANCE);

                    let output: string[] | undefined;
                    expect(() => {
                        output = buildSvgSafely(model);
                    }).toThrow(InvalidDielineModelError);
                    expect(output).toBeUndefined();
                },
            ),
            { numRuns: 100 },
        );
    });

    it('model có segment thiếu điểm (< 2 điểm) phải ném InvalidDielineModelError', () => {
        fc.assert(
            fc.property(arbBoxParams('rte'), (params: BoxParams) => {
                const bad: PathSegment[] = [
                    { points: [P(0, 0)], tag: 'CUT', type: 'line' }, // chỉ 1 điểm
                ];
                const model = wrapModel(bad, params);

                let output: string[] | undefined;
                expect(() => {
                    output = buildSvgSafely(model);
                }).toThrow(InvalidDielineModelError);
                expect(output).toBeUndefined();
            }),
            { numRuns: 100 },
        );
    });

    it('model hợp lệ (chuỗi cắt khép kín) KHÔNG bị từ chối', () => {
        fc.assert(
            fc.property(arbBoxParams('rte'), (params: BoxParams) => {
                const closedSquare: PathSegment[] = [
                    { points: [P(0, 0), P(100, 0)], tag: 'CUT', type: 'line' },
                    { points: [P(100, 0), P(100, 100)], tag: 'CUT', type: 'line' },
                    { points: [P(100, 100), P(0, 100)], tag: 'CUT', type: 'line' },
                    { points: [P(0, 100), P(0, 0)], tag: 'CUT', type: 'line' },
                ];
                const model = wrapModel(closedSquare, params);
                expect(() => assertValidGeometryModel(model)).not.toThrow();
            }),
            { numRuns: 100 },
        );
    });
});
