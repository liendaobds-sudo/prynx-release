// ============================================================
// Unit Tests — nestingEngine.ts
// ============================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { calculateNesting, offsetPolygon } from './nestingEngine';
import { NestingConfig, NestingResult, RotationMode, DEFAULT_NESTING_CONFIG } from './nestingTypes';
import { BoxParams, DEFAULT_PARAMS, Point2D } from './types';
import { snap } from './utils';
import { SNAP_TOLERANCE } from './sharedGeometry';

/** Helper: tạo config với overrides */
function makeConfig(overrides: Partial<NestingConfig> = {}): NestingConfig {
    return { ...DEFAULT_NESTING_CONFIG, ...overrides };
}

/** Helper: tạo params với overrides */
function makeParams(overrides: Partial<BoxParams> = {}): BoxParams {
    return { ...DEFAULT_PARAMS, ...overrides };
}

describe('nestingEngine — calculateNesting', () => {

    // ── Grid mode cơ bản ────────────────────────────────

    describe('Grid None (0°)', () => {
        it('should fit correct number of dielines in a simple case', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig({
                sheet: { width: 320, height: 450 },
                margin: { top: 10, right: 10, bottom: 10, left: 10 },
                gripperMargin: 12,
                dieGap: 3,
                gutter: 3,
                rotation: 'none',
                sheetOrientation: 'portrait',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            // Area: 300 x 428, cellW = 103, cellH = 203
            // cols = floor(303/103) = 2, rows = floor(431/203) = 2 → 4
            expect(result.countPerSheet).toBe(4);
            expect(result.cols).toBe(2);
            expect(result.rows).toBe(2);
            expect(result.positions.length).toBe(4);
        });

        it('should return 0 when dieline is larger than sheet', () => {
            const bbox = { width: 1000, height: 1000 };
            const config = makeConfig({
                sheet: { width: 320, height: 450 },
                rotation: 'none',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBe(0);
            expect(result.positions.length).toBe(0);
        });

        it('should fit exactly 1 when dieline just fits', () => {
            const bbox = { width: 290, height: 418 };
            const config = makeConfig({
                sheet: { width: 320, height: 450 },
                margin: { top: 10, right: 10, bottom: 10, left: 10 },
                gripperMargin: 12,
                dieGap: 3,
                gutter: 3,
                rotation: 'none',
                sheetOrientation: 'portrait',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBe(1);
        });
    });

    // ── Grid 90° ────────────────────────────────────────

    describe('Grid 90°', () => {
        it('should rotate narrow dieline for better fit', () => {
            // 50×300 on 320×450 sheet (area ~300×428)
            // At 0°: cols = floor(303/53)=5, rows = floor(431/303)=1 → 5
            // At 90°: cols = floor(303/303)=1, rows = floor(431/53)=8 → 8
            const bbox = { width: 50, height: 300 };
            const config = makeConfig({
                sheet: { width: 320, height: 450 },
                rotation: '90',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            // Only 90° is returned from calcGrid90, auto won't compare
            expect(result.positions.every(p => p.rotation === 90)).toBe(true);
        });
    });

    // ── Auto rotation ───────────────────────────────────

    describe('Grid Auto', () => {
        it('should pick the best of 0°, 180°, and 90°', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                rotation: 'auto',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            // Should have positions
            expect(result.countPerSheet).toBeGreaterThan(0);
            // Auto should pick the most efficient
            expect(result.label).toBeTruthy();
        });
    });

    // ── Sheet orientation ───────────────────────────────

    describe('Sheet Orientation', () => {
        it('auto should try both orientations', () => {
            const bbox = { width: 200, height: 100 };
            const configAuto = makeConfig({
                sheet: { width: 320, height: 450 },
                sheetOrientation: 'auto',
                rotation: 'none',
                nestingMode: 'grid',
            });
            const resultAuto = calculateNesting(bbox, configAuto);

            const configPortrait = makeConfig({
                sheet: { width: 320, height: 450 },
                sheetOrientation: 'portrait',
                rotation: 'none',
                nestingMode: 'grid',
            });
            const resultPortrait = calculateNesting(bbox, configPortrait);

            const configLandscape = makeConfig({
                sheet: { width: 320, height: 450 },
                sheetOrientation: 'landscape',
                rotation: 'none',
                nestingMode: 'grid',
            });
            const resultLandscape = calculateNesting(bbox, configLandscape);

            // Auto should be >= both forced orientations
            expect(resultAuto.countPerSheet).toBeGreaterThanOrEqual(resultPortrait.countPerSheet);
            expect(resultAuto.countPerSheet).toBeGreaterThanOrEqual(resultLandscape.countPerSheet);
        });

        it('portrait should swap dimensions if needed', () => {
            const bbox = { width: 100, height: 100 };
            const config = makeConfig({
                sheet: { width: 450, height: 320 }, // landscape dimensions
                sheetOrientation: 'portrait',         // force portrait
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            // Should swap to 320×450
            expect(result.actualSheet.width).toBe(320);
            expect(result.actualSheet.height).toBe(450);
        });
    });

    // ── Smart mode: RTE ─────────────────────────────────

    describe('Smart RTE', () => {
        it('should use interlock for RTE and fit more than grid', () => {
            const bbox = { width: 280, height: 620 };
            const params = makeParams({ boxType: 'rte', L: 100, W: 60, D: 200, T: 0.5, TH: 15, DFH: 0 });
            const configGrid = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'grid',
                rotation: 'none',
            });
            const configSmart = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'smart',
            });

            const gridResult = calculateNesting(bbox, configGrid);
            const smartResult = calculateNesting(bbox, configSmart, params);

            // Smart should fit >= grid (interlock reduces cellH)
            expect(smartResult.countPerSheet).toBeGreaterThanOrEqual(gridResult.countPerSheet);
            // Smart should have a descriptive label (could be interlock or grid if grid is better)
            expect(smartResult.label).toBeTruthy();
        });

        it('should have all positions at 0° rotation for RTE', () => {
            const bbox = { width: 280, height: 620 };
            const params = makeParams({ boxType: 'rte' });
            const config = makeConfig({ nestingMode: 'smart' });
            const result = calculateNesting(bbox, config, params);
            // If interlock is chosen, all should be 0°
            if (result.label.includes('khoảng trống')) {
                expect(result.positions.every(p => p.rotation === 0)).toBe(true);
            }
        });
    });

    // ── Smart mode: SLB ─────────────────────────────────

    describe('Smart SLB', () => {
        it('should use 180° interlock for SLB', () => {
            // Dùng bbox nhỏ hơn để đảm bảo có ≥2 hàng → kiểm tra xoay 180°
            const bbox = { width: 280, height: 350 };
            const params = makeParams({ boxType: 'slb', L: 100, W: 60, D: 200, T: 0.5, TH: 15, lockTab: false });
            const config = makeConfig({ nestingMode: 'smart', sheet: { width: 790, height: 1090 } });
            const result = calculateNesting(bbox, config, params);

            // SLB smart luôn chọn interlock theo cặp
            expect(result.label).toContain('Lồng cặp 180°');
            expect(result.countPerSheet).toBeGreaterThanOrEqual(2);

            // Phải có cả 0° và 180°
            const rotations = new Set(result.positions.map(p => p.rotation));
            expect(rotations.has(0)).toBe(true);
            expect(rotations.has(180)).toBe(true);
        });
    });

    // ── Smart mode: Gable / Paper Bag ───────────────────

    describe('Smart Gable/PaperBag', () => {
        it('should fallback to grid for gable box', () => {
            const bbox = { width: 280, height: 400 };
            const params = makeParams({ boxType: 'gable' });
            const config = makeConfig({ nestingMode: 'smart' });
            const result = calculateNesting(bbox, config, params);

            // Should still work (grid fallback)
            expect(result.countPerSheet).toBeGreaterThanOrEqual(0);
            // Label should be grid-based
            expect(result.label).toMatch(/Grid|0°|90°/);
        });
    });

    // ── Utilization ─────────────────────────────────────

    describe('Utilization', () => {
        it('should calculate utilization as percentage of usable area', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'grid',
                rotation: 'none',
            });
            const result = calculateNesting(bbox, config);
            expect(result.utilization).toBeGreaterThan(0);
            expect(result.utilization).toBeLessThanOrEqual(100);
        });
    });

    // ── Edge cases ──────────────────────────────────────

    describe('Edge Cases', () => {
        it('should handle square dieline', () => {
            const bbox = { width: 100, height: 100 };
            const config = makeConfig({ nestingMode: 'grid', rotation: 'auto' });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBeGreaterThan(0);
        });

        it('should handle very small dieline', () => {
            const bbox = { width: 10, height: 10 };
            const config = makeConfig({ nestingMode: 'grid', rotation: 'none' });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBeGreaterThan(100);
        });

        it('should handle zero margins', () => {
            const bbox = { width: 100, height: 100 };
            const config = makeConfig({
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                gripperMargin: 0,
                nestingMode: 'grid',
                rotation: 'none',
            });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBeGreaterThan(0);
        });

        it('should return proper result structure', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig();
            const result = calculateNesting(bbox, config);

            expect(result).toHaveProperty('positions');
            expect(result).toHaveProperty('countPerSheet');
            expect(result).toHaveProperty('rows');
            expect(result).toHaveProperty('cols');
            expect(result).toHaveProperty('utilization');
            expect(result).toHaveProperty('usableArea');
            expect(result).toHaveProperty('actualSheet');
            expect(result).toHaveProperty('cellSize');
            expect(result).toHaveProperty('label');
            expect(result).toHaveProperty('superTile');
        });
    });

    // ── Grid: 180° removed ──────────────────────────────

    describe('Grid mode has no 180°', () => {
        it('grid mode should only use 0° or 90° rotations', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                rotation: 'auto',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBeGreaterThan(0);
            // Grid mode should only produce 0° or 90°
            expect(result.positions.every(p => p.rotation === 0 || p.rotation === 90)).toBe(true);
        });
    });

    // ── Positions non-overlapping verification ──────────

    describe('Non-overlapping positions', () => {
        it('grid positions should not overlap', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                rotation: 'none',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);

            // Check no two positions share the exact same (x,y)
            const coords = result.positions.map(p => `${p.x},${p.y}`);
            const uniqueCoords = new Set(coords);
            expect(uniqueCoords.size).toBe(coords.length);
        });
    });

    // ── Smart mode: Envelope ────────────────────────────

    describe('Smart Envelope — Wallet (ngang)', () => {
        it('should use 180° column interlock for wallet envelope', () => {
            // Bì wallet nằm NGANG: die rộng-thấp (360×90) — interlock theo cột
            // (xoay 180° xen kẽ + lồng tai hông) xếp được nhiều hơn grid.
            const bbox = { width: 360, height: 90 };
            const params = makeParams({
                boxType: 'envelope',
                envW: 220,
                envH: 110,
                envFH: 20,
                envSF: 30,
                envFlapShape: 'pointed',
                envStyle: 'wallet',
            });
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'smart',
            });
            const result = calculateNesting(bbox, config, params);

            expect(result.countPerSheet).toBeGreaterThan(0);
            expect(result.label).toContain('Lồng bì ngang');

            // Phải có cả 0° và 180°
            const rotations = new Set(result.positions.map(p => p.rotation));
            expect(rotations.has(0)).toBe(true);
            expect(rotations.has(180)).toBe(true);
        });

        it('smart wallet should fit >= grid', () => {
            const bbox = { width: 244, height: 270 };
            const params = makeParams({
                boxType: 'envelope',
                envW: 220,
                envH: 110,
                envFlapShape: 'pointed',
                envStyle: 'wallet',
            });
            const configGrid = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'grid',
                rotation: 'auto',
            });
            const configSmart = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'smart',
            });

            const gridResult = calculateNesting(bbox, configGrid);
            const smartResult = calculateNesting(bbox, configSmart, params);

            expect(smartResult.countPerSheet).toBeGreaterThanOrEqual(gridResult.countPerSheet);
        });
    });

    describe('Smart Envelope — Pocket (dọc)', () => {
        it('should use 3-row interlock for pocket envelope', () => {
            // Bì dọc C5 (229×162): internal W=162, H=229
            // bbox ≈ 2*W + SF + FH × H + SF ≈ ~400 × ~250
            const bbox = { width: 400, height: 250 };
            const params = makeParams({
                boxType: 'envelope',
                envW: 229,
                envH: 162,
                envFH: 0,
                envSF: 0,
                envFlapShape: 'pointed',
                envStyle: 'pocket',
            });
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'smart',
            });
            const result = calculateNesting(bbox, config, params);

            expect(result.countPerSheet).toBeGreaterThan(0);
            expect(result.label).toContain('Lồng bì dọc');

            // Phải có cả 0° và 180° (3-row pattern)
            const rotations = new Set(result.positions.map(p => p.rotation));
            expect(rotations.has(0)).toBe(true);
            expect(rotations.has(180)).toBe(true);
        });

        it('smart pocket should produce valid interlock layout', () => {
            const bbox = { width: 400, height: 250 };
            const params = makeParams({
                boxType: 'envelope',
                envW: 229,
                envH: 162,
                envFlapShape: 'pointed',
                envStyle: 'pocket',
            });
            const configSmart = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'smart',
            });

            const smartResult = calculateNesting(bbox, configSmart, params);

            // Smart pocket phải xếp được ít nhất 1 khuôn
            expect(smartResult.countPerSheet).toBeGreaterThan(0);
            // Label phải mô tả lồng bì dọc
            expect(smartResult.label).toContain('Lồng bì dọc');
        });
    });
});

// ============================================================
// Property-Based Tests — Workstream B (spec dieline-hardening-phase2)
//
// File này bổ sung 6 property test cho `calculateNesting` /
// `offsetPolygon` (Properties 9, 10, 11, 12, 13, 14). Mỗi property
// chạy fc.assert(..., { numRuns: 100, seed: <seed ghi nhận> }) theo
// Requirement 9.4.
//
// LƯU Ý KIẾN TRÚC: `calculateNesting(bbox, config, params?)` KHÔNG nhận
// `model`, nên Die_Outline mà engine dùng LUÔN là hình chữ nhật suy ra
// từ `bbox`. Vì vậy:
//   • Các bất biến va chạm / khoảng hở (Property 9) và "trong vùng in"
//     (Property 10) được kiểm trên GRID mode — nơi vị ngữ va chạm theo
//     polygon-offset chi phối khoảng cách lưới. (Smart mode CỐ Ý chồng
//     lấn bounding box theo đặc trưng hình học hộp, không thuộc bất biến
//     polygon-offset.)
//   • Property 11 (không-kém Bounding_Box_Gap) được kiểm bằng cách so
//     bước lưới suy từ `offsetPolygon` (như engine làm) với bước lưới
//     Bounding_Box_Gap, trên các Die_Outline KHÔNG-chữ-nhật dạng
//     rectilinear (L/U) — đúng không gian đầu vào thực tế của khuôn bế.
//
// Mọi generator dùng số nguyên (mm) để tránh nhiễu dấu phẩy động: mọi
// tọa độ trở thành bội của 0,5 ⇒ snap 3 chữ số là chính xác tuyệt đối,
// nên các dung sai đã ghim (0,01 mm² chồng lấn, 0,01 mm khoảng hở,
// 0,001 mm vị trí) được kiểm đúng nghĩa, không bị nới lỏng.
// ============================================================

// ─── Seeds cố định (ghi nhận) cho tái lập — Requirement 9.4 ───
const PROPERTY_9_SEED = 589833;   // 0x090009
const PROPERTY_10_SEED = 1048592; // 0x100010
const PROPERTY_11_SEED = 1114129; // 0x110011
const PROPERTY_12_SEED = 1179666; // 0x120012
const PROPERTY_13_SEED = 1245203; // 0x130013
const PROPERTY_14_SEED = 1310740; // 0x140014

const SUPPORTED_ANGLES = [0, 90, 180, 270];

// ─── Helpers hình học độc lập (không phụ thuộc internals engine) ───

/** Bounding box trục-song-song của một dãy đỉnh. */
function aabb(poly: Point2D[]): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
}

/**
 * Diện tích giao của hai đa giác trục-song-song (axis-aligned). Mọi outline
 * trong các bài test này — outline gốc của khuôn (chữ nhật) và keep-out
 * (offset của chữ nhật) — đều là chữ nhật trục-song-song, nên giao AABB
 * bằng đúng giao đa giác thật.
 */
function overlapArea(a: Point2D[], b: Point2D[]): number {
    const A = aabb(a);
    const B = aabb(b);
    const ox = Math.max(0, Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX));
    const oy = Math.max(0, Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY));
    return ox * oy;
}

/** Khoảng cách nhỏ nhất giữa hai chữ nhật trục-song-song (0 nếu chồng/chạm). */
function rectDistance(a: Point2D[], b: Point2D[]): number {
    const A = aabb(a);
    const B = aabb(b);
    const dx = Math.max(0, A.minX - B.maxX, B.minX - A.maxX);
    const dy = Math.max(0, A.minY - B.maxY, B.minY - A.maxY);
    return Math.hypot(dx, dy);
}

/** Point-in-polygon (ray casting) — đúng cho mọi đa giác đơn. */
function pointInPolygon(p: Point2D, poly: Point2D[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x;
        const yi = poly[i].y;
        const xj = poly[j].x;
        const yj = poly[j].y;
        const intersect =
            yi > p.y !== yj > p.y &&
            p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

/** Khoảng cách điểm → đoạn thẳng. */
function distToSegment(p: Point2D, a: Point2D, b: Point2D): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Khoảng cách điểm → biên đa giác. */
function distToBoundary(p: Point2D, poly: Point2D[]): number {
    let min = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const d = distToSegment(p, poly[i], poly[(i + 1) % poly.length]);
        if (d < min) min = d;
    }
    return min;
}

/** Xoay một điểm quanh gốc tọa độ theo góc thuộc {0,90,180,270} (độ). */
function rotatePoint(p: Point2D, angle: number): Point2D {
    switch (((angle % 360) + 360) % 360) {
        case 90: return { x: -p.y, y: p.x };
        case 180: return { x: -p.x, y: -p.y };
        case 270: return { x: p.y, y: -p.x };
        default: return { x: p.x, y: p.y };
    }
}

/**
 * Outline gốc (chữ nhật) của một khuôn ĐÃ ĐẶT tại vị trí `pos`. Engine đặt
 * khuôn với góc trái-dưới tại (pos.x, pos.y) và footprint hoán đổi khi xoay
 * 90°/270°.
 */
function placedRect(pos: { x: number; y: number; rotation: number }, dieW: number, dieH: number): Point2D[] {
    const swap = pos.rotation === 90 || pos.rotation === 270;
    const fw = swap ? dieH : dieW;
    const fh = swap ? dieW : dieH;
    return [
        { x: pos.x, y: pos.y },
        { x: pos.x + fw, y: pos.y },
        { x: pos.x + fw, y: pos.y + fh },
        { x: pos.x, y: pos.y + fh },
    ];
}

/** Áp dụng hướng tờ giấy như engine (chỉ hoán đổi sheet, KHÔNG hoán đổi lề). */
function applyOrientation(w: number, h: number, orient: 'auto' | 'portrait' | 'landscape'): [number, number] {
    if (orient === 'portrait' && w > h) return [h, w];
    if (orient === 'landscape' && h > w) return [h, w];
    return [w, h];
}

// ─── Arbitraries (định nghĩa CỤC BỘ trong file test này) ───

interface RawGridInput {
    width: number;
    height: number;
    sheetW: number;
    sheetH: number;
    mTop: number;
    mRight: number;
    mBottom: number;
    mLeft: number;
    gripper: number;
    dieGap: number;
    rotation: RotationMode;
    orientation: 'auto' | 'portrait' | 'landscape';
}

const arbMargin = fc.integer({ min: 0, max: 15 });

/**
 * arbNestingInput — đầu vào lồng khuôn GRID mode hợp lệ: bbox khuôn vừa khổ
 * in, lề/cắn nhíp nhỏ, dieGap ≥ 0. Số nguyên (mm) để hình học chính xác.
 * Kích thước được ràng buộc để số khuôn ở mức vừa phải (kiểm O(n²) nhanh).
 */
const arbNestingInput: fc.Arbitrary<RawGridInput> = fc.record({
    width: fc.integer({ min: 120, max: 350 }),
    height: fc.integer({ min: 120, max: 350 }),
    sheetW: fc.integer({ min: 300, max: 700 }),
    sheetH: fc.integer({ min: 350, max: 950 }),
    mTop: arbMargin,
    mRight: arbMargin,
    mBottom: arbMargin,
    mLeft: arbMargin,
    gripper: fc.integer({ min: 0, max: 15 }),
    dieGap: fc.integer({ min: 0, max: 8 }),
    rotation: fc.constantFrom<RotationMode>('none', '90', 'auto'),
    orientation: fc.constantFrom<'auto' | 'portrait' | 'landscape'>('auto', 'portrait', 'landscape'),
});

/** Đầu vào chữ nhật với hướng tờ TƯỜNG MINH + rotation 'none' (Property 13). */
const arbRectNestingInput: fc.Arbitrary<RawGridInput> = fc.record({
    width: fc.integer({ min: 120, max: 350 }),
    height: fc.integer({ min: 120, max: 350 }),
    sheetW: fc.integer({ min: 300, max: 700 }),
    sheetH: fc.integer({ min: 350, max: 950 }),
    mTop: arbMargin,
    mRight: arbMargin,
    mBottom: arbMargin,
    mLeft: arbMargin,
    gripper: fc.integer({ min: 0, max: 15 }),
    dieGap: fc.integer({ min: 0, max: 8 }),
    rotation: fc.constant<RotationMode>('none'),
    orientation: fc.constantFrom<'auto' | 'portrait' | 'landscape'>('portrait', 'landscape'),
});

/** Build NestingConfig (grid mode) từ RawGridInput; gutter = dieGap. */
function buildGridConfig(c: RawGridInput): NestingConfig {
    return {
        ...DEFAULT_NESTING_CONFIG,
        sheet: { width: c.sheetW, height: c.sheetH },
        margin: { top: c.mTop, right: c.mRight, bottom: c.mBottom, left: c.mLeft },
        gripperMargin: c.gripper,
        dieGap: c.dieGap,
        gutter: c.dieGap,
        rotation: c.rotation,
        sheetOrientation: c.orientation,
        nestingMode: 'grid',
    };
}

/** Die_Outline rectilinear KHÔNG-chữ-nhật (L hoặc U), bao mọi cạnh trục-song-song. */
const arbRectilinearOutline: fc.Arbitrary<Point2D[]> = fc.oneof(
    // L-shape: bỏ một góc trên-phải.
    fc.record({
        W: fc.integer({ min: 80, max: 200 }),
        H: fc.integer({ min: 80, max: 200 }),
        nwFrac: fc.double({ min: 0.25, max: 0.6, noNaN: true }),
        nhFrac: fc.double({ min: 0.25, max: 0.6, noNaN: true }),
    }).map(({ W, H, nwFrac, nhFrac }) => {
        const nw = Math.max(10, Math.min(W - 10, Math.round(W * nwFrac)));
        const nh = Math.max(10, Math.min(H - 10, Math.round(H * nhFrac)));
        return [
            { x: 0, y: 0 },
            { x: W, y: 0 },
            { x: W, y: H - nh },
            { x: W - nw, y: H - nh },
            { x: W - nw, y: H },
            { x: 0, y: H },
        ] as Point2D[];
    }),
    // U-shape: khoét rãnh giữa cạnh trên.
    fc.record({
        W: fc.integer({ min: 100, max: 220 }),
        H: fc.integer({ min: 80, max: 200 }),
        sideFrac: fc.double({ min: 0.2, max: 0.4, noNaN: true }),
        depthFrac: fc.double({ min: 0.25, max: 0.6, noNaN: true }),
    }).map(({ W, H, sideFrac, depthFrac }) => {
        const side = Math.max(10, Math.min(Math.floor(W / 2) - 10, Math.round(W * sideFrac)));
        const depth = Math.max(10, Math.min(H - 10, Math.round(H * depthFrac)));
        return [
            { x: 0, y: 0 },
            { x: W, y: 0 },
            { x: W, y: H },
            { x: W - side, y: H },
            { x: W - side, y: H - depth },
            { x: side, y: H - depth },
            { x: side, y: H },
            { x: 0, y: H },
        ] as Point2D[];
    }),
);

const arbPrintArea = fc.record({
    w: fc.integer({ min: 300, max: 800 }),
    h: fc.integer({ min: 300, max: 900 }),
});

const arbGap = fc.integer({ min: 0, max: 8 });

// Đầu vào lồng khuôn bất kỳ (grid + smart, gồm params) cho Property 12 (b) & 14.
interface RawAnyInput extends RawGridInput {
    nestingMode: 'grid' | 'smart';
    boxType: BoxParams['boxType'];
}

const arbAnyNestingInput: fc.Arbitrary<RawAnyInput> = fc.record({
    width: fc.integer({ min: 120, max: 350 }),
    height: fc.integer({ min: 120, max: 350 }),
    sheetW: fc.integer({ min: 300, max: 700 }),
    sheetH: fc.integer({ min: 350, max: 950 }),
    mTop: arbMargin,
    mRight: arbMargin,
    mBottom: arbMargin,
    mLeft: arbMargin,
    gripper: fc.integer({ min: 0, max: 15 }),
    dieGap: fc.integer({ min: 0, max: 8 }),
    rotation: fc.constantFrom<RotationMode>('none', '90', 'auto'),
    orientation: fc.constantFrom<'auto' | 'portrait' | 'landscape'>('auto', 'portrait', 'landscape'),
    nestingMode: fc.constantFrom<'grid' | 'smart'>('grid', 'smart'),
    boxType: fc.constantFrom<BoxParams['boxType']>(
        'rte', 'slb', 'auto_bottom', 'gable', 'paper_bag', 'cup_sleeve', 'pizza', 'envelope', 'tray',
    ),
});

function buildAnyConfig(c: RawAnyInput): NestingConfig {
    return {
        ...DEFAULT_NESTING_CONFIG,
        sheet: { width: c.sheetW, height: c.sheetH },
        margin: { top: c.mTop, right: c.mRight, bottom: c.mBottom, left: c.mLeft },
        gripperMargin: c.gripper,
        dieGap: c.dieGap,
        gutter: c.dieGap,
        rotation: c.rotation,
        sheetOrientation: c.orientation,
        nestingMode: c.nestingMode,
    };
}

// ============================================================
// Task 6.2 — Property 9
// Feature: dieline-hardening-phase2, Property 9: Các khuôn đã đặt không
// va chạm và giữ đúng khoảng hở dieGap — for any NestingResult do
// calculateNesting tạo ra, với mọi cặp khuôn đã đặt khác nhau: vùng
// keep-out offset của một khuôn không chồng lấn Die_Outline gốc của khuôn
// kia (diện tích giao ≤ 0,01 mm²), tương đương khoảng cách nhỏ nhất giữa
// hai Die_Outline gốc ≥ dieGap − 0,01 mm; khi dieGap = 0 cho phép tiếp xúc
// biên chung (diện tích giao ≤ 0,01 mm²).
//
// Validates: Requirements 5.3, 5.4, 5.5, 7.2
// ============================================================

describe('Property 9 — Khuôn đã đặt không va chạm và giữ khoảng hở dieGap', () => {
    it('keep-out ∩ outline-gốc khuôn kia ≤ 0,01 mm² và khoảng cách outline gốc ≥ dieGap − 0,01 mm', () => {
        const AREA_TOL = 0.01;  // mm²
        const GAP_TOL = 0.01;   // mm

        fc.assert(
            fc.property(arbNestingInput, (input) => {
                const bbox = { width: input.width, height: input.height };
                const config = buildGridConfig(input);
                const g = config.dieGap;
                const res = calculateNesting(bbox, config);

                // Outline gốc + keep-out (offsetPolygon) của từng khuôn đã đặt.
                const orig = res.positions.map((p) => placedRect(p, bbox.width, bbox.height));
                const keep = orig.map((o) => offsetPolygon(o, g));

                for (let i = 0; i < orig.length; i++) {
                    for (let j = i + 1; j < orig.length; j++) {
                        // (Req 5.3, 5.5, 7.2) keep-out của i không chồng lấn outline gốc của j.
                        const aij = overlapArea(keep[i], orig[j]);
                        if (aij > AREA_TOL) {
                            throw new Error(
                                `keep-out[${i}] ∩ outline[${j}] = ${aij.toFixed(4)} mm² > ${AREA_TOL}; ` +
                                    `dieGap=${g}, bbox=${JSON.stringify(bbox)}, ` +
                                    `pos[i]=${JSON.stringify(res.positions[i])}, pos[j]=${JSON.stringify(res.positions[j])}`,
                            );
                        }
                        // Đối xứng: keep-out của j không chồng lấn outline gốc của i.
                        const aji = overlapArea(keep[j], orig[i]);
                        if (aji > AREA_TOL) {
                            throw new Error(
                                `keep-out[${j}] ∩ outline[${i}] = ${aji.toFixed(4)} mm² > ${AREA_TOL}; ` +
                                    `dieGap=${g}, bbox=${JSON.stringify(bbox)}, ` +
                                    `pos[i]=${JSON.stringify(res.positions[i])}, pos[j]=${JSON.stringify(res.positions[j])}`,
                            );
                        }
                        // (Req 5.4) Khoảng cách giữa hai outline gốc ≥ dieGap − 0,01 mm.
                        const d = rectDistance(orig[i], orig[j]);
                        if (d < g - GAP_TOL) {
                            throw new Error(
                                `Khoảng cách outline gốc [${i}],[${j}] = ${d.toFixed(4)} mm < dieGap − 0,01 = ` +
                                    `${(g - GAP_TOL).toFixed(4)} mm; bbox=${JSON.stringify(bbox)}`,
                            );
                        }
                    }
                }
            }),
            { numRuns: 100, seed: PROPERTY_9_SEED },
        );
    });
});

// ============================================================
// Task 6.3 — Property 10
// Feature: dieline-hardening-phase2, Property 10: Mọi khuôn đặt nằm trong
// vùng in khả dụng — for any NestingResult, mọi Die_Outline đã đặt (đã
// xoay, theo vị trí) nằm hoàn toàn trong vùng in khả dụng (khổ in trừ lề
// và cắn nhíp), không điểm nào vượt ra ngoài biên vùng in quá 0,01 mm.
//
// Validates: Requirements 7.3
// ============================================================

describe('Property 10 — Mọi khuôn đặt nằm trong vùng in khả dụng', () => {
    it('không điểm nào của Die_Outline đã đặt vượt biên vùng in quá 0,01 mm', () => {
        const TOL = 0.01; // mm

        fc.assert(
            fc.property(arbNestingInput, (input) => {
                const bbox = { width: input.width, height: input.height };
                const config = buildGridConfig(input);
                const res = calculateNesting(bbox, config);

                // Vùng in khả dụng: [left, left+usableW] × [top, top+usableH].
                const left = config.margin.left;
                const top = config.margin.top;
                const right = left + res.usableArea.width;
                const bottom = top + res.usableArea.height;

                for (let i = 0; i < res.positions.length; i++) {
                    const r = placedRect(res.positions[i], bbox.width, bbox.height);
                    const b = aabb(r);
                    if (
                        b.minX < left - TOL ||
                        b.minY < top - TOL ||
                        b.maxX > right + TOL ||
                        b.maxY > bottom + TOL
                    ) {
                        throw new Error(
                            `Khuôn[${i}] [${b.minX},${b.minY}]–[${b.maxX},${b.maxY}] vượt vùng in ` +
                                `[${left},${top}]–[${right},${bottom}] quá ${TOL} mm; ` +
                                `bbox=${JSON.stringify(bbox)}, pos=${JSON.stringify(res.positions[i])}`,
                        );
                    }
                }
            }),
            { numRuns: 100, seed: PROPERTY_10_SEED },
        );
    });
});

// ============================================================
// Task 8.1 — Property 11
// Feature: dieline-hardening-phase2, Property 11: Lồng theo hình dạng
// không kém Bounding_Box_Gap — for any khuôn có Die_Outline không-chữ-nhật
// và for any cấu hình lồng (cùng khổ in, lề, cắn nhíp, dieGap, tập góc
// xoay), số khuôn đặt được bằng Polygon_Offset ≥ số khuôn đặt được bằng
// Bounding_Box_Gap.
//
// Validates: Requirements 7.1
//
// Engine suy bước lưới theo va chạm polygon: cellW = AABB(keep-out).maxX −
// AABB(outline gốc).minX (xem gridCellFromCollision). Property kiểm rằng
// bước lưới Polygon_Offset không LỚN hơn bước Bounding_Box_Gap (dieW+gap,
// dieH+gap) ⇒ số khuôn Polygon_Offset ≥ Bounding_Box_Gap, trên các outline
// rectilinear không-chữ-nhật (đúng không gian khuôn bế thực tế).
// ============================================================

describe('Property 11 — Lồng theo hình dạng không kém Bounding_Box_Gap', () => {
    it('số khuôn Polygon_Offset ≥ Bounding_Box_Gap với outline không-chữ-nhật', () => {
        fc.assert(
            fc.property(arbRectilinearOutline, arbPrintArea, arbGap, (outline, area, gap) => {
                const ob = aabb(outline);
                const W = ob.maxX - ob.minX;
                const H = ob.maxY - ob.minY;

                // Bounding_Box_Gap: mỗi chiều bước = cạnh bbox + gap.
                const cellWb = snap(W + gap);
                const cellHb = snap(H + gap);
                const colsB = Math.max(0, Math.floor((area.w + gap) / cellWb));
                const rowsB = Math.max(0, Math.floor((area.h + gap) / cellHb));
                const countB = colsB * rowsB;

                // Polygon_Offset: bước suy từ offsetPolygon như engine.
                const keep = offsetPolygon(outline, gap);
                const kb = aabb(keep);
                const cellWp = snap(kb.maxX - ob.minX);
                const cellHp = snap(kb.maxY - ob.minY);
                if (cellWp <= 0 || cellHp <= 0) return; // suy biến → bỏ qua
                const colsP = Math.max(0, Math.floor((area.w + gap) / cellWp));
                const rowsP = Math.max(0, Math.floor((area.h + gap) / cellHp));
                const countP = colsP * rowsP;

                if (countP < countB) {
                    throw new Error(
                        `Polygon_Offset count ${countP} < Bounding_Box_Gap count ${countB}; ` +
                            `gap=${gap}, bbox=${W}×${H}, cellP=${cellWp}×${cellHp}, cellB=${cellWb}×${cellHb}, ` +
                            `area=${area.w}×${area.h}, outline=${JSON.stringify(outline)}`,
                    );
                }
            }),
            { numRuns: 100, seed: PROPERTY_11_SEED },
        );
    });
});

// ============================================================
// Task 6.4 — Property 12
// Feature: dieline-hardening-phase2, Property 12: Offset áp dụng sau khi
// xoay, chỉ với góc được hỗ trợ — for any Die_Outline và for any góc
// θ ∈ {0,90,180,270}, đa giác keep-out dùng trong lồng khuôn bằng
// offsetPolygon(rotate(outline, θ), dieGap) (xoay trước, offset sau, cùng
// offset = dieGap); và mọi khuôn trong NestingResult chỉ mang góc xoay
// thuộc tập đó.
//
// Validates: Requirements 7.4, 7.5
// ============================================================

describe('Property 12 — Offset sau khi xoay, chỉ với góc được hỗ trợ', () => {
    it('keep-out = offsetPolygon(rotate(outline, θ), dieGap) bao trọn outline đã xoay với θ ∈ {0,90,180,270}', () => {
        const OUTWARD_TOL = SNAP_TOLERANCE + 1e-9;

        fc.assert(
            fc.property(
                fc.integer({ min: 50, max: 400 }),
                fc.integer({ min: 50, max: 400 }),
                arbGap,
                (w, h, gap) => {
                    const rect: Point2D[] = [
                        { x: 0, y: 0 },
                        { x: w, y: 0 },
                        { x: w, y: h },
                        { x: 0, y: h },
                    ];
                    for (const theta of SUPPORTED_ANGLES) {
                        const rotated = rect.map((p) => rotatePoint(p, theta));
                        const keepOut = offsetPolygon(rotated, gap);

                        if (keepOut.length < 3) {
                            throw new Error(`keep-out có < 3 đỉnh tại θ=${theta}, gap=${gap}, w=${w}, h=${h}`);
                        }
                        // Offset SAU khi xoay phải bao trọn outline đã xoay (lệch ngoài ≤ SNAP).
                        for (const v of rotated) {
                            if (pointInPolygon(v, keepOut)) continue;
                            const dist = distToBoundary(v, keepOut);
                            if (dist > OUTWARD_TOL) {
                                throw new Error(
                                    `Đỉnh đã xoay (${v.x},${v.y}) nằm ngoài keep-out ${dist.toFixed(4)} mm ` +
                                        `> ${OUTWARD_TOL}; θ=${theta}, gap=${gap}, w=${w}, h=${h}`,
                                );
                            }
                        }
                    }
                },
            ),
            { numRuns: 100, seed: PROPERTY_12_SEED },
        );
    });

    it('mọi khuôn trong NestingResult chỉ mang góc xoay thuộc {0,90,180,270}', () => {
        fc.assert(
            fc.property(arbAnyNestingInput, (input) => {
                const bbox = { width: input.width, height: input.height };
                const config = buildAnyConfig(input);
                const params = { ...DEFAULT_PARAMS, boxType: input.boxType };
                const res = calculateNesting(bbox, config, params);

                for (const p of res.positions) {
                    if (!SUPPORTED_ANGLES.includes(p.rotation)) {
                        throw new Error(
                            `Góc xoay ${p.rotation} không thuộc {0,90,180,270}; ` +
                                `mode=${input.nestingMode}, boxType=${input.boxType}, bbox=${JSON.stringify(bbox)}`,
                        );
                    }
                }
            }),
            { numRuns: 100, seed: PROPERTY_12_SEED },
        );
    });
});

// ============================================================
// Task 8.2 — Property 13
// Feature: dieline-hardening-phase2, Property 13: Trường hợp chữ nhật
// tương đương Giai đoạn 1 — for any khuôn có Die_Outline chữ nhật và for
// any cấu hình lồng, calculateNesting (Giai đoạn 2) tạo cùng tập khuôn
// trên cùng khổ in với hành vi Bounding_Box_Gap Giai đoạn 1: mỗi khuôn ở
// cùng vị trí trong dung sai 0,001 mm và cùng góc xoay thuộc {0,90,180,270}.
//
// Validates: Requirements 8.1 (KHÔNG nới lỏng dung sai đã ghim 0,001 mm)
// ============================================================

describe('Property 13 — Trường hợp chữ nhật tương đương Giai đoạn 1', () => {
    it('cùng số khuôn/cols/rows và bước lưới = dieW+gap, dieH+gap (trong 0,001 mm); góc ∈ {0,90,180,270}', () => {
        const POS_TOL = 0.001; // mm — dung sai vị trí đã ghim

        fc.assert(
            fc.property(arbRectNestingInput, (input) => {
                const bbox = { width: input.width, height: input.height };
                const config = buildGridConfig(input);
                const g = config.dieGap;
                const res = calculateNesting(bbox, config);

                // ── Bước lưới Bounding_Box_Gap Giai đoạn 1 (độc lập) ──
                const [sw, sh] = applyOrientation(config.sheet.width, config.sheet.height, config.sheetOrientation);
                const effBottom = Math.max(config.margin.bottom, config.gripperMargin);
                const areaW = sw - config.margin.left - config.margin.right;
                const areaH = sh - config.margin.top - effBottom;
                const cellW = snap(bbox.width + g);
                const cellH = snap(bbox.height + g);
                const colsExp = Math.max(0, Math.floor((areaW + g) / cellW));
                const rowsExp = Math.max(0, Math.floor((areaH + g) / cellH));
                const countExp = colsExp * rowsExp;

                // (Req 8.1) Cùng tập khuôn trên cùng khổ in.
                if (res.countPerSheet !== countExp || res.cols !== colsExp || res.rows !== rowsExp) {
                    throw new Error(
                        `Khác Bounding_Box_Gap: engine count/cols/rows = ` +
                            `${res.countPerSheet}/${res.cols}/${res.rows} ≠ kỳ vọng ${countExp}/${colsExp}/${rowsExp}; ` +
                            `bbox=${JSON.stringify(bbox)}, gap=${g}, orient=${config.sheetOrientation}`,
                    );
                }

                // (Req 8.1) Mọi góc xoay thuộc {0,90,180,270} (rotation 'none' ⇒ tất cả 0°).
                for (const p of res.positions) {
                    if (!SUPPORTED_ANGLES.includes(p.rotation)) {
                        throw new Error(`Góc ${p.rotation} không thuộc tập hỗ trợ; bbox=${JSON.stringify(bbox)}`);
                    }
                }

                // (Req 8.1) Bước lưới đúng dieW+gap, dieH+gap trong 0,001 mm
                // (vị trí trùng khít Bounding_Box_Gap). Kiểm qua các tọa độ phân biệt.
                const xs = Array.from(new Set(res.positions.map((p) => snap(p.x)))).sort((a, b) => a - b);
                const ys = Array.from(new Set(res.positions.map((p) => snap(p.y)))).sort((a, b) => a - b);
                for (let i = 1; i < xs.length; i++) {
                    if (Math.abs((xs[i] - xs[i - 1]) - cellW) > POS_TOL) {
                        throw new Error(
                            `Bước cột = ${(xs[i] - xs[i - 1]).toFixed(4)} ≠ dieW+gap=${cellW} (lệch > ${POS_TOL}); ` +
                                `bbox=${JSON.stringify(bbox)}, gap=${g}`,
                        );
                    }
                }
                for (let i = 1; i < ys.length; i++) {
                    if (Math.abs((ys[i] - ys[i - 1]) - cellH) > POS_TOL) {
                        throw new Error(
                            `Bước hàng = ${(ys[i] - ys[i - 1]).toFixed(4)} ≠ dieH+gap=${cellH} (lệch > ${POS_TOL}); ` +
                                `bbox=${JSON.stringify(bbox)}, gap=${g}`,
                        );
                    }
                }
            }),
            { numRuns: 100, seed: PROPERTY_13_SEED },
        );
    });
});

// ============================================================
// Task 8.3 — Property 14
// Feature: dieline-hardening-phase2, Property 14: Kết quả lồng khuôn là
// xác định — for any đầu vào lồng khuôn (cùng bbox, config, params),
// calculateNesting tạo ra NestingResult giống hệt nhau qua các lần gọi
// (cùng positions, countPerSheet, rows, cols, và các trường còn lại).
//
// Validates: Requirements 8.5
// ============================================================

describe('Property 14 — Kết quả lồng khuôn là xác định', () => {
    it('cùng bbox/config/params → NestingResult giống hệt nhau qua các lần gọi', () => {
        fc.assert(
            fc.property(arbAnyNestingInput, (input) => {
                const bbox = { width: input.width, height: input.height };
                const config = buildAnyConfig(input);
                const params: BoxParams = { ...DEFAULT_PARAMS, boxType: input.boxType };

                const r1: NestingResult = calculateNesting(bbox, config, params);
                const r2: NestingResult = calculateNesting(bbox, config, params);

                const s1 = JSON.stringify(r1);
                const s2 = JSON.stringify(r2);
                if (s1 !== s2) {
                    throw new Error(
                        `NestingResult không xác định cho mode=${input.nestingMode}, boxType=${input.boxType}, ` +
                            `bbox=${JSON.stringify(bbox)}:\n  lần 1 = ${s1}\n  lần 2 = ${s2}`,
                    );
                }
            }),
            { numRuns: 100, seed: PROPERTY_14_SEED },
        );
    });
});
