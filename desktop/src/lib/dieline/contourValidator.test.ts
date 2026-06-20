// ============================================================
// contourValidator.test.ts
//
// Bao gồm hai task tùy chọn của spec dieline-hardening:
//   • Task 4.2 — Property 1: Validator phân loại đúng tính khép kín
//     của biên dạng (Validates Requirements 1.1, 1.2, 1.5, 1.8)
//   • Task 4.3 — Smoke test tái dùng tracePerimeter (Requirement 1.6)
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fc from 'fast-check';

import { validateClosedContours } from './contourValidator';
import { SNAP_TOLERANCE } from './sharedGeometry';
import { arbBoxParams, GeneratorBoxType } from './arbitraries';
import { BoxParams, DielineModel, PathSegment, Point2D } from './types';

import { generateReverseTuckEnd } from './ReverseTuckEnd';
import { generateSnapLockBottom } from './SnapLockBottom';
import { generateGableBox } from './GableBox';
import { generatePaperBag } from './PaperBag';
import { generateCupSleeve } from './CupSleeve';
import { generatePizzaBox } from './PizzaBox';
import { generateEnvelope } from './Envelope';
import { generateMatchboxTray } from './MatchboxTray';

// ─── Dispatch boxType → generator ───────────────────────────
const GENERATORS: Record<GeneratorBoxType, (p: BoxParams) => DielineModel> = {
    rte: generateReverseTuckEnd,
    slb: generateSnapLockBottom,
    gable: generateGableBox,
    paper_bag: generatePaperBag,
    cup_sleeve: generateCupSleeve,
    pizza: generatePizzaBox,
    envelope: generateEnvelope,
    tray: generateMatchboxTray,
};

// ─── Phạm vi Property 1 ─────────────────────────────────────
// Property 1 khẳng định "model mới sinh → allClosed=true". Điều
// này chỉ đúng với các generator phát ra biên cắt ngoài KHÉP KÍN
// hoàn toàn theo định nghĩa crease-aware của Contour_Validator
// (mọi đầu mút CUT/BLEED trùng một đầu mút khác, kể cả CREASE).
//
// 5 generator dưới đây thỏa mãn. 3 generator còn lại — rte, slb
// (rãnh gài/relief slit của lưỡi đút: đường cắt cố ý kết thúc
// giữa vật liệu) và envelope (vết cắt ngón dạng cung hở trên nắp)
// — CỐ Ý chứa đặc trưng cắt hở nội bộ, vốn không phải "biên ngoài"
// của Cut_Piece, nên bị loại khỏi khẳng định allClosed=true (xem
// ghi chú phạm vi trong contourValidator.ts). Sửa hình học của
// chúng để khép kín đồ thị cắt sẽ vi phạm Requirement 7.3.
const CLOSEABLE_TYPES: GeneratorBoxType[] = [
    'gable', 'paper_bag', 'cup_sleeve', 'pizza', 'tray',
];

// ============================================================
// Task 4.2 — Property 1
// Feature: dieline-hardening, Property 1: Validator phân loại đúng
// tính khép kín của biên dạng — for any DielineModel hợp lệ,
// validateClosedContours trả về allClosed=true và openContours rỗng;
// for any model thu được bằng cách dịch chuyển một endpoint của một
// Cut_Piece đi d > SNAP_TOLERANCE, validator phải báo allClosed=false
// và openContours chứa đúng panel bị nhiễu cùng gapMm ≈ d.
//
// Validates: Requirements 1.1, 1.2, 1.5, 1.8
// ============================================================

/**
 * Dịch chuyển một endpoint của một Cut_Piece đi một vector độ dài `d`
 * để tạo một biên cắt hở "sạch". Để khoảng hở đo được bằng đúng `d`,
 * hàm chọn một đỉnh là góc CUT–CUT bậc đúng 2 (điểm chỉ được chia sẻ
 * bởi đúng 2 đầu mút CUT/BLEED và KHÔNG có đầu mút CREASE nào): khi dịch
 * một trong hai cạnh đi, cả điểm bị dịch lẫn điểm bạn (mất kết nối duy
 * nhất) đều trở thành đầu hở ⇒ thành phần có đúng 2 đầu hở cách nhau `d`.
 *
 * Trả về model đã clone + chỉ số panel bị nhiễu, hoặc null nếu không
 * tìm được đỉnh phù hợp cho mẫu này.
 *
 * Hướng dịch chuyển (0.6, 0.8) là vector đơn vị ⇒ độ dời = d.
 */
function perturbOneEndpoint(
    model: DielineModel,
    d: number,
): { perturbed: DielineModel; panelIndex: number } | null {
    const perturbed: DielineModel = structuredClone(model);

    // Đầu mút của tất cả segment, kèm cờ có phải CUT/BLEED hay không.
    const ends: { p: Point2D; cut: boolean }[] = [];
    for (const s of perturbed.allPaths) {
        const cut = s.tag === 'CUT' || s.tag === 'BLEED';
        const pts =
            s.type === 'bezier' && s.controlPoints
                ? [s.controlPoints[0], s.controlPoints[3]]
                : [s.points[0], s.points[s.points.length - 1]];
        ends.push({ p: pts[0], cut }, { p: pts[1], cut });
    }
    const eq = (a: Point2D, b: Point2D) =>
        Math.abs(a.x - b.x) < SNAP_TOLERANCE && Math.abs(a.y - b.y) < SNAP_TOLERANCE;

    // Một đỉnh là góc CUT–CUT bậc 2 nếu tổng số đầu mút trùng = 2 và cả
    // hai đều là CUT/BLEED.
    const isCleanCutCorner = (q: Point2D): boolean => {
        let total = 0;
        let cutCount = 0;
        for (const e of ends) {
            if (eq(e.p, q)) {
                total++;
                if (e.cut) cutCount++;
            }
        }
        return total === 2 && cutCount === 2;
    };

    for (let i = 0; i < perturbed.panels.length; i++) {
        const panel = perturbed.panels[i];
        const cutSegs = panel.paths.filter(
            (s: PathSegment) => s.tag === 'CUT' || s.tag === 'BLEED',
        );
        for (const seg of cutSegs) {
            if (seg.type !== 'line' || !seg.points || seg.points.length < 2) continue;
            const p0 = seg.points[0];
            if (!isCleanCutCorner(p0)) continue;
            seg.points[0] = { x: p0.x + d * 0.6, y: p0.y + d * 0.8 } as Point2D;
            return { perturbed, panelIndex: i };
        }
    }
    return null;
}

describe('Property 1 — validateClosedContours phân loại tính khép kín', () => {
    for (const boxType of CLOSEABLE_TYPES) {
        it(`closed model is allClosed; perturbed endpoint is reported open (${boxType})`, () => {
            fc.assert(
                fc.property(
                    arbBoxParams(boxType),
                    fc.double({ min: 0.5, max: 200, noNaN: true, noDefaultInfinity: true }),
                    (params: BoxParams, d: number) => {
                        const model = GENERATORS[boxType](params);

                        // ── Phần 1: model khép kín ⇒ allClosed=true (Req 1.8) ──
                        const res = validateClosedContours(model);
                        expect(res.allClosed).toBe(true);
                        expect(res.openContours).toEqual([]);

                        // ── Phần 2: nhiễu loạn 1 endpoint ⇒ báo đúng panel hở,
                        //    gapMm ≈ d (Req 1.1, 1.2, 1.5) ──
                        const pert = perturbOneEndpoint(model, d);
                        if (!pert) return; // không có panel phù hợp cho mẫu này

                        const res2 = validateClosedContours(pert.perturbed);
                        expect(res2.allClosed).toBe(false);

                        // Cut_Piece nay là THÀNH PHẦN LIÊN THÔNG của toàn bộ
                        // đoạn CUT/BLEED (không còn ánh xạ 1-1 panel→Cut_Piece),
                        // nên định danh Cut_Piece bị nhiễu qua khoảng hở đo được:
                        // dịch chuyển 1 endpoint đi d làm hở đúng thành phần đó
                        // với gapMm ≈ d. Dung sai so khớp = 2·SNAP_TOLERANCE vì
                        // hai endpoint vốn "trùng" theo ptEq có thể lệch tới
                        // SNAP_TOLERANCE mỗi trục (Euclid ≈ 0.0141mm), khiến khoảng
                        // hở đầu-cuối đo được lệch d một lượng cỡ snap tolerance.
                        const reported = res2.openContours.find(
                            (oc) => Math.abs(oc.gapMm - d) <= 2 * SNAP_TOLERANCE,
                        );
                        expect(reported).toBeDefined();
                        // Cảnh báo phải định danh được panel đại diện (không rỗng).
                        expect(reported!.panelName.length).toBeGreaterThan(0);
                        expect(typeof reported!.cutPieceIndex).toBe('number');
                    },
                ),
                { numRuns: 100 },
            );
        });
    }
});

// ============================================================
// Task 4.3 — Smoke test: contourValidator tái dùng tracePerimeter
// (Requirement 1.6) — KHÔNG hiện thực thuật toán nối chuỗi thứ hai.
// ============================================================

function readValidatorSource(): string {
    const candidates = [
        // sibling của file test (robust nhất)
        (() => {
            try {
                const here = dirname(fileURLToPath(import.meta.url));
                return join(here, 'contourValidator.ts');
            } catch {
                return '';
            }
        })(),
        // process.cwd() = desktop root khi chạy vitest
        join(process.cwd(), 'src', 'lib', 'dieline', 'contourValidator.ts'),
        join(process.cwd(), 'desktop', 'src', 'lib', 'dieline', 'contourValidator.ts'),
    ].filter(Boolean);

    for (const p of candidates) {
        if (existsSync(p)) return readFileSync(p, 'utf8');
    }
    throw new Error(
        `Không tìm thấy contourValidator.ts. Đã thử: ${candidates.join(', ')}`,
    );
}

describe('Smoke — contourValidator tái dùng tracePerimeter (Req 1.6)', () => {
    const src = readValidatorSource();

    it('import tracePerimeter từ ./tracePerimeter', () => {
        expect(src).toMatch(
            /import\s*\{[^}]*\btracePerimeter\b[^}]*\}\s*from\s*['"]\.\/tracePerimeter['"]/,
        );
    });

    it('thực sự GỌI tracePerimeter(...)', () => {
        expect(src).toMatch(/tracePerimeter\s*\(/);
    });

    it('import SNAP_TOLERANCE từ ./sharedGeometry', () => {
        expect(src).toMatch(
            /import\s*\{[^}]*\bSNAP_TOLERANCE\b[^}]*\}\s*from\s*['"]\.\/sharedGeometry['"]/,
        );
    });

    it('KHÔNG định nghĩa thuật toán nối chuỗi thứ hai (không có buildChains cục bộ)', () => {
        expect(src).not.toMatch(/function\s+buildChains/);
        expect(src).not.toMatch(/\bconst\s+buildChains\b/);
    });

    it('KHÔNG có vòng lặp nối chuỗi (while-loop chaining) trùng lặp', () => {
        expect(src).not.toMatch(/\bwhile\s*\(/);
    });
});
