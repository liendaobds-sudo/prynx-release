// ============================================================
// regression.test.ts — Hồi quy hình học generator (golden master)
//
// Feature: dieline-hardening, Property 9: Hình học generator ổn định
// và xác định (chống hồi quy). For any generator và for any bộ params
// hợp lệ, `panels` và `allPaths` đầu ra có cùng số lượng và cùng thứ tự
// phần tử so với baseline đã ghi, và mỗi tọa độ điểm tương ứng lệch
// không quá 0.001 mm; sinh hai lần cùng params cho kết quả đồng nhất.
//
// **Validates: Requirements 7.3** (Giai đoạn 1)
//
// Giai đoạn 2 — Task 10.1 TÁI DÙNG chính baseline golden-master này
// làm cổng bất biến hình học generator: **Validates: Requirements 4.1,
// 4.4** (panels/allPaths của cả 8 generator giữ `tag`/`type`/số điểm và
// mỗi tọa độ lệch ≤ 0.001 mm so với baseline; chứng minh thay đổi Giai
// đoạn 2 KHÔNG làm đổi hình học generator).
//
// Khác với goldenMaster.test.ts (task 2.5) — vốn chụp chuỗi SVG `d` của
// Shared_Geometry_Module — test này KHOÁ trực tiếp cấu trúc hình học do
// GENERATOR sinh ra (panels + allPaths với toàn bộ tọa độ điểm). Có 2 tầng:
//   1. Xác định (determinism, PBT): sinh hai lần cùng params phải đồng nhất
//      về số lượng/thứ tự phần tử và mọi tọa độ lệch ≤ 0.001 mm.
//   2. Golden master (snapshot): baseline cấu trúc panels/allPaths cho các
//      fixture params CỐ ĐỊNH; drift số lượng/thứ tự/tọa độ sẽ làm fail.
// Khi fail, thông báo lỗi nêu rõ generator + phần tử sai lệch (Req 7.4).
// ============================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { BoxParams, DEFAULT_PARAMS, DielineModel, Panel, PathSegment, Point2D } from './types';
import { arbBoxParams, GeneratorBoxType } from './arbitraries';
import { generateReverseTuckEnd } from './ReverseTuckEnd';
import { generateSnapLockBottom } from './SnapLockBottom';
import { generateAutoBottomBox } from './AutoBottomBox';
import { generateGableBox } from './GableBox';
import { generatePaperBag } from './PaperBag';
import { generateCupSleeve } from './CupSleeve';
import { generatePizzaBox } from './PizzaBox';
import { generateEnvelope } from './Envelope';
import { generateMatchboxTray } from './MatchboxTray';

/** Dung sai tọa độ hồi quy hình học theo Requirement 7.3 (GEOMETRY_TOLERANCE). */
const GEOMETRY_TOLERANCE = 0.001; // mm

/** 8 generator ↔ boxType. Mỗi generator chạy riêng để counterexample chỉ rõ tên (Req 7.4). */
const GENERATORS: { boxType: GeneratorBoxType; name: string; generate: (p: BoxParams) => DielineModel }[] = [
    { boxType: 'rte', name: 'generateReverseTuckEnd', generate: generateReverseTuckEnd },
    { boxType: 'slb', name: 'generateSnapLockBottom', generate: generateSnapLockBottom },
    { boxType: 'auto_bottom', name: 'generateAutoBottomBox', generate: generateAutoBottomBox },
    { boxType: 'gable', name: 'generateGableBox', generate: generateGableBox },
    { boxType: 'paper_bag', name: 'generatePaperBag', generate: generatePaperBag },
    { boxType: 'cup_sleeve', name: 'generateCupSleeve', generate: generateCupSleeve },
    { boxType: 'pizza', name: 'generatePizzaBox', generate: generatePizzaBox },
    { boxType: 'envelope', name: 'generateEnvelope', generate: generateEnvelope },
    { boxType: 'tray', name: 'generateMatchboxTray', generate: generateMatchboxTray },
];

/** Làm tròn tọa độ về 0.001 mm, triệt tiêu -0 để snapshot ổn định. */
function roundCoord(v: number): number {
    const r = Math.round(v * 1000) / 1000;
    return Object.is(r, -0) ? 0 : r;
}

const roundPoint = (p: Point2D): { x: number; y: number } => ({ x: roundCoord(p.x), y: roundCoord(p.y) });

/**
 * So sánh hai tọa độ điểm; ném lỗi mô tả khi lệch > GEOMETRY_TOLERANCE.
 * `where` định vị phần tử sai lệch để báo cáo (Req 7.4).
 */
function assertPointClose(genName: string, where: string, a: Point2D, b: Point2D): void {
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    if (dx > GEOMETRY_TOLERANCE || dy > GEOMETRY_TOLERANCE) {
        throw new Error(
            `[${genName}] Hồi quy hình học: tọa độ lệch > ${GEOMETRY_TOLERANCE}mm tại ${where}: ` +
                `(${a.x}, ${a.y}) vs (${b.x}, ${b.y}) — Δx=${dx.toFixed(6)}, Δy=${dy.toFixed(6)}`,
        );
    }
}

/** So khớp chuỗi PathSegment: cùng số lượng/thứ tự (tag, type, số điểm) và mọi tọa độ ≤ 0.001 mm. */
function assertSegmentsMatch(genName: string, scope: string, a: PathSegment[], b: PathSegment[]): void {
    if (a.length !== b.length) {
        throw new Error(
            `[${genName}] Hồi quy hình học: ${scope} khác số lượng segment (${a.length} vs ${b.length})`,
        );
    }
    for (let i = 0; i < a.length; i++) {
        const sa = a[i];
        const sb = b[i];
        if (sa.tag !== sb.tag || sa.type !== sb.type) {
            throw new Error(
                `[${genName}] Hồi quy hình học: ${scope}[${i}] khác thứ tự/loại ` +
                    `(tag ${sa.tag}/${sb.tag}, type ${sa.type}/${sb.type})`,
            );
        }
        if (sa.points.length !== sb.points.length) {
            throw new Error(
                `[${genName}] Hồi quy hình học: ${scope}[${i}] khác số điểm ` +
                    `(${sa.points.length} vs ${sb.points.length})`,
            );
        }
        for (let j = 0; j < sa.points.length; j++) {
            assertPointClose(genName, `${scope}[${i}].points[${j}]`, sa.points[j], sb.points[j]);
        }
    }
}

/** So khớp hai DielineModel: panels + allPaths cùng số lượng/thứ tự và mọi tọa độ ≤ 0.001 mm (Req 7.3/7.4). */
function assertModelsMatch(genName: string, a: DielineModel, b: DielineModel): void {
    // panels: số lượng + thứ tự
    if (a.panels.length !== b.panels.length) {
        throw new Error(
            `[${genName}] Hồi quy hình học: khác số lượng panel (${a.panels.length} vs ${b.panels.length})`,
        );
    }
    for (let pi = 0; pi < a.panels.length; pi++) {
        const pa = a.panels[pi];
        const pb = b.panels[pi];
        if (pa.name !== pb.name) {
            throw new Error(
                `[${genName}] Hồi quy hình học: panel[${pi}] khác thứ tự/tên ("${pa.name}" vs "${pb.name}")`,
            );
        }
        assertSegmentsMatch(genName, `panel[${pi}]("${pa.name}").paths`, pa.paths, pb.paths);
    }
    // allPaths: số lượng + thứ tự
    assertSegmentsMatch(genName, 'allPaths', a.allPaths, b.allPaths);
}

/** Trích cấu trúc hình học ổn định (tọa độ đã làm tròn) để snapshot golden master. */
function snapshotPanel(panel: Panel) {
    return {
        name: panel.name,
        label: panel.label,
        parent: panel.parent,
        foldAngle: panel.foldAngle,
        foldDirection: panel.foldDirection,
        paths: panel.paths.map(snapshotSegment),
    };
}

function snapshotSegment(seg: PathSegment) {
    return {
        tag: seg.tag,
        type: seg.type,
        points: seg.points.map(roundPoint),
    };
}

function snapshotModel(model: DielineModel) {
    return {
        name: model.name,
        standardCode: model.standardCode,
        panelCount: model.panels.length,
        allPathCount: model.allPaths.length,
        panels: model.panels.map(snapshotPanel),
        allPaths: model.allPaths.map(snapshotSegment),
        boundingBox: {
            minX: roundCoord(model.boundingBox.minX),
            minY: roundCoord(model.boundingBox.minY),
            maxX: roundCoord(model.boundingBox.maxX),
            maxY: roundCoord(model.boundingBox.maxY),
            width: roundCoord(model.boundingBox.width),
            height: roundCoord(model.boundingBox.height),
        },
    };
}

/** Params cố định, xác định từ DEFAULT_PARAMS + override (không random) cho golden master. */
const make = (overrides: Partial<BoxParams>): BoxParams => ({ ...DEFAULT_PARAMS, ...overrides });

/** Một fixture cố định / loại hộp — khoá baseline cấu trúc generator. */
const FIXTURES: { name: string; generate: (p: BoxParams) => DielineModel; params: BoxParams }[] = [
    { name: 'rte (Reverse Tuck End)', generate: generateReverseTuckEnd, params: make({ boxType: 'rte', L: 100, W: 60, D: 200 }) },
    { name: 'slb (Snap-Lock Bottom)', generate: generateSnapLockBottom, params: make({ boxType: 'slb', L: 120, W: 80, D: 180 }) },
    { name: 'auto_bottom (Hộp đáy dán)', generate: generateAutoBottomBox, params: make({ boxType: 'auto_bottom', L: 120, W: 80, D: 180 }) },
    { name: 'gable (Gable Box)', generate: generateGableBox, params: make({ boxType: 'gable', L: 150, W: 90, D: 220 }) },
    { name: 'paper_bag (Túi giấy SOS)', generate: generatePaperBag, params: make({ boxType: 'paper_bag', L: 180, W: 100, D: 250 }) },
    { name: 'cup_sleeve (Bọc ly)', generate: generateCupSleeve, params: make({ boxType: 'cup_sleeve', cupD1: 70, cupD2: 80, cupH: 90 }) },
    { name: 'pizza (Pizza Box FEFCO 0426)', generate: generatePizzaBox, params: make({ boxType: 'pizza', L: 300, W: 300, D: 40 }) },
    { name: 'envelope (Bì thư DL)', generate: generateEnvelope, params: make({ boxType: 'envelope', envW: 220, envH: 110 }) },
    { name: 'tray (Hộp diêm / Khay)', generate: generateMatchboxTray, params: make({ boxType: 'tray', L: 100, W: 60, D: 30 }) },
];

// ─── Tầng 1: Xác định (determinism) — Property 9 (PBT) ───────────────

describe('Property 9: Hình học generator xác định (sinh hai lần đồng nhất ≤ 0.001mm)', () => {
    for (const g of GENERATORS) {
        it(`${g.name} sinh hai lần cùng params cho panels/allPaths đồng nhất`, () => {
            fc.assert(
                fc.property(arbBoxParams(g.boxType), (params: BoxParams) => {
                    const first = g.generate(params);
                    const second = g.generate(params);
                    // Ném lỗi mô tả (nêu generator + phần tử) khi lệch — Req 7.4
                    assertModelsMatch(g.name, first, second);
                }),
                { numRuns: 100 },
            );
        });
    }
});

// ─── Tầng 2: Golden master — baseline cấu trúc cố định (Req 7.3) ─────

describe('Property 9: Golden master cấu trúc generator (panels/allPaths vs baseline)', () => {
    for (const fx of FIXTURES) {
        it(`giữ nguyên số lượng/thứ tự/tọa độ panels & allPaths cho ${fx.name}`, () => {
            const model = fx.generate(fx.params);

            // Baseline phải có nội dung hợp lệ
            expect(model.panels.length).toBeGreaterThan(0);
            expect(model.allPaths.length).toBeGreaterThan(0);

            // Khoá baseline cấu trúc generator (drift số lượng/thứ tự/tọa độ → fail)
            expect(snapshotModel(model)).toMatchSnapshot();
        });
    }
});

// ─── Tầng 2b: Tự kiểm chứng helper so khớp (báo đúng generator + phần tử) ─

describe('Property 9: helper assertModelsMatch phát hiện & định vị sai lệch (Req 7.4)', () => {
    const base = generateReverseTuckEnd(make({ boxType: 'rte', L: 100, W: 60, D: 200 }));

    it('chấp nhận model giống hệt chính nó', () => {
        expect(() => assertModelsMatch('generateReverseTuckEnd', base, base)).not.toThrow();
    });

    it('phát hiện lệch tọa độ > 0.001mm và nêu tên generator + phần tử', () => {
        const mutated: DielineModel = structuredClone(base);
        // Nhiễu loạn một tọa độ vượt dung sai (structuredClone tách tham chiếu panels/allPaths)
        mutated.allPaths[0].points[0].x += 0.01;
        // Thông báo nêu tên generator + định vị tới points[...] của phần tử sai lệch (Req 7.4)
        expect(() => assertModelsMatch('generateReverseTuckEnd', base, mutated)).toThrowError(
            /\[generateReverseTuckEnd\].*tọa độ lệch.*points\[0\]/s,
        );
    });

    it('phát hiện khác số lượng/thứ tự panel', () => {
        const mutated: DielineModel = structuredClone(base);
        mutated.panels.pop();
        expect(() => assertModelsMatch('generateReverseTuckEnd', base, mutated)).toThrowError(
            /\[generateReverseTuckEnd\].*số lượng panel/s,
        );
    });

    it('không báo lỗi khi lệch nằm trong dung sai ≤ 0.001mm', () => {
        const mutated: DielineModel = structuredClone(base);
        mutated.allPaths[0].points[0].x += 0.0005; // dưới ngưỡng
        expect(() => assertModelsMatch('generateReverseTuckEnd', base, mutated)).not.toThrow();
    });
});
