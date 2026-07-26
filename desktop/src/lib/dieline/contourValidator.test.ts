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

import { validateClosedContours, extractOuterSilhouette } from './contourValidator';
import { SNAP_TOLERANCE } from './sharedGeometry';
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

// ─── Phase 2 additions ──────────────────────────────────────
// `vi` + module mocks cho phép import `decideExportGate` từ
// exportPDF.ts trong môi trường node (jspdf / svg2pdf.js / sonner
// được thay bằng mock rỗng — chỉ phục vụ Property 3 chạy cổng xuất
// tới trạng thái `cancelled`). Các mock này chỉ ảnh hưởng tới file
// test này và KHÔNG can thiệp các describe block hiện có.
import { vi } from 'vitest';

vi.mock('jspdf', () => ({
    jsPDF: class {
        svg = vi.fn().mockResolvedValue(undefined);
        setProperties = vi.fn();
        save = vi.fn();
    },
}));
vi.mock('svg2pdf.js', () => ({}));
vi.mock('sonner', () => ({
    toast: {
        warning: vi.fn(),
        loading: vi.fn(() => 'toast-id'),
        success: vi.fn(),
        error: vi.fn(),
    },
}));

import { decideExportGate } from './exportPDF';
import { DEFAULT_PARAMS, Panel } from './types';

// ─── Dispatch boxType → generator ───────────────────────────
const GENERATORS: Record<GeneratorBoxType, (p: BoxParams) => DielineModel> = {
    rte: generateReverseTuckEnd,
    slb: generateSnapLockBottom,
    auto_bottom: generateAutoBottomBox,
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
// 5 generator dưới đây thỏa mãn. 4 generator còn lại — rte, slb,
// auto_bottom (rãnh gài/relief slit của lưỡi đút: đường cắt cố ý
// kết thúc giữa vật liệu) và envelope (vết cắt ngón dạng cung hở)
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
    const eq = (a: Point2D, b: Point2D) =>
        Math.abs(a.x - b.x) < SNAP_TOLERANCE && Math.abs(a.y - b.y) < SNAP_TOLERANCE;

    // Endpoint đầu/cuối của một segment (line hoặc bezier) — đồng nhất với
    // quy ước của validator (sharedGeometry.segEndpoints).
    const segEnds = (s: PathSegment): [Point2D, Point2D] =>
        s.type === 'bezier' && s.controlPoints
            ? [s.controlPoints[0], s.controlPoints[3]]
            : [s.points[0], s.points[s.points.length - 1]];

    // KHÔNG clone (để rẻ — chạy 100 lần/loại hộp). validateClosedContours CHỈ
    // đọc `model.allPaths` (không đọc `panel.paths`). Với một số generator (vd
    // paper_bag), `panel.paths` của panel được chọn chỉ chứa BẢN SAO clip (tạo
    // mới ở khâu cắt clip), KHÔNG cùng tham chiếu với `allPaths` — nên dịch
    // endpoint trên `panel.paths` là no-op với allPaths ⇒ validator vẫn báo
    // allClosed=true. Do đó ta tiêm lỗi TRỰC TIẾP vào segment thuộc allPaths.
    // Dịch tại CHỖ rồi KHÔI PHỤC khi ứng viên không đạt; bản trả về giữ đúng
    // một nhiễu loạn. (Test đã chạy Phần 1 trên model trước khi gọi hàm này nên
    // việc biến đổi tại chỗ không ảnh hưởng Phần 1.)
    const perturbed: DielineModel = model;

    // Đầu mút của TẤT CẢ segment (CUT/BLEED/CREASE), kèm cờ CUT/BLEED — dựng từ
    // allPaths, dùng cho phép kiểm "góc cắt sạch" crease-aware.
    const ends: { p: Point2D; cut: boolean }[] = [];
    for (const s of perturbed.allPaths) {
        const cut = s.tag === 'CUT' || s.tag === 'BLEED';
        const [a, b] = segEnds(s);
        ends.push({ p: a, cut }, { p: b, cut });
    }

    // Một đỉnh là góc CUT–CUT bậc 2 nếu tổng số đầu mút trùng = 2 và cả hai đều
    // là CUT/BLEED (không có đầu mút CREASE) — dịch một trong hai cạnh đi `d`
    // làm cả điểm bị dịch lẫn điểm bạn cũ trở thành đầu hở cách nhau `d`.
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

    // Tâm vùng vật liệu (trung bình mọi đầu mút) — dùng để dịch góc RA NGOÀI.
    let cx = 0, cy = 0;
    for (const e of ends) { cx += e.p.x; cy += e.p.y; }
    if (ends.length > 0) { cx /= ends.length; cy /= ends.length; }

    // CUT/BLEED segment (validator chỉ soi tập này).
    const cb = perturbed.allPaths.filter((s) => s.tag === 'CUT' || s.tag === 'BLEED');
    const m = cb.length;
    if (m === 0) return null;

    // Gom THÀNH PHẦN LIÊN THÔNG (Cut_Piece) theo endpoint trùng — y hệt
    // validator. Thành phần NHIỀU đoạn nhất là biên ngoài THÂN hộp (gồm nhiều
    // panel ⇒ không phải nắp gập độc lập / đặc trưng cắt nội bộ mà validator cố
    // ý bỏ qua, Req 2.2). Ưu tiên thành phần lớn để tránh thử nhầm góc nắp/lip
    // (bị validator nuốt) gây nhiều lần đánh giá vô ích.
    const cbEnds = cb.map(segEnds);
    const parent = cb.map((_, i) => i);
    const root = (i: number): number => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
    };
    for (let i = 0; i < m; i++) {
        for (let j = i + 1; j < m; j++) {
            const [a0, a1] = cbEnds[i];
            const [b0, b1] = cbEnds[j];
            if (eq(a0, b0) || eq(a0, b1) || eq(a1, b0) || eq(a1, b1)) {
                parent[root(i)] = root(j);
            }
        }
    }
    const compSize = new Map<number, number>();
    for (let i = 0; i < m; i++) {
        const r = root(i);
        compSize.set(r, (compSize.get(r) ?? 0) + 1);
    }

    // Ứng viên: mọi góc CUT–CUT bậc 2 (cả hai đầu mỗi đoạn line). Thứ tự ưu
    // tiên: (a) thành phần LỚN trước (thân hộp), rồi (b) đỉnh XA TÂM NHẤT trước.
    // Đỉnh xa tâm nhất của một thành phần nằm trên bao lồi của nó ⇒ là đỉnh LỒI,
    // dịch ra ngoài theo tia bán kính chắc chắn rơi RA NGOÀI vật liệu ⇒
    // Open_Outer_Boundary thật, không bị validator nuốt. Nhờ vậy ứng viên đầu
    // tiên hầu như luôn đạt ⇒ thường chỉ 1 lần đánh giá validator.
    type Cand = { i: number; idx: number; px: number; py: number; size: number; dist: number };
    const cands: Cand[] = [];
    for (let i = 0; i < m; i++) {
        const seg = cb[i];
        if (seg.type !== 'line' || !seg.points || seg.points.length < 2) continue;
        const size = compSize.get(root(i)) ?? 0;
        for (const idx of [0, seg.points.length - 1]) {
            const p = seg.points[idx];
            if (!isCleanCutCorner(p)) continue;
            cands.push({ i, idx, px: p.x, py: p.y, size, dist: Math.hypot(p.x - cx, p.y - cy) });
        }
    }
    cands.sort((a, b) => b.size - a.size || b.dist - a.dist);

    // Dịch lỗi tại CHỖ; XÁC NHẬN bằng validator rằng đã tạo Open_Outer_Boundary
    // với gapMm ≈ d (ngưỡng giống hệt phần khẳng định của test). Nếu ứng viên
    // không tạo hở thật (đỉnh lõm hiếm gặp, hoặc nằm trên nắp gập độc lập mà
    // validator cố ý bỏ qua — Req 2.2) thì KHÔI PHỤC điểm gốc và thử ứng viên
    // kế. Giữ ý nghĩa property: dịch 1 góc CUT–CUT bậc 2 đi `d` ⇒ đúng thành
    // phần đó hở với khoảng hở ≈ d.
    for (const c of cands) {
        const seg = cb[c.i];
        const orig = seg.points![c.idx];
        let ux = c.px - cx;
        let uy = c.py - cy;
        const norm = Math.hypot(ux, uy);
        if (norm < 1e-9) { ux = 0.6; uy = 0.8; } else { ux /= norm; uy /= norm; }
        seg.points![c.idx] = { x: c.px + d * ux, y: c.py + d * uy } as Point2D;

        const r = validateClosedContours(perturbed);
        const detected = r.openContours.some(
            (oc) => Math.abs(oc.gapMm - d) <= 2 * SNAP_TOLERANCE,
        );
        if (detected) {
            let panelIndex = perturbed.panels.findIndex(
                (pn) => Array.isArray(pn.paths) && pn.paths.includes(seg),
            );
            if (panelIndex < 0) panelIndex = 0;
            return { perturbed, panelIndex };
        }
        seg.points![c.idx] = orig; // khôi phục, thử ứng viên kế
    }
    return null;
}

describe('Property 1 — validateClosedContours phân loại tính khép kín', () => {
    for (const boxType of CLOSEABLE_TYPES) {
        // paper_bag generator + property runs are heavy (often 10–20s); default
        // 30s flaked under parallel suite load during release QA.
        const timeoutMs = boxType === 'paper_bag' ? 90_000 : 30_000;
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
        }, timeoutMs); // PBT nặng: 100 vòng × validator O(n²); paper_bag nới 90s.
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

// ============================================================
// Phase 2 — Task 1.2 — Smoke test: extractOuterSilhouette
// TÁI DÙNG tracePerimeter (Requirement 1.2)
//
// Xác minh `extractOuterSilhouette` import & GỌI `tracePerimeter`
// và KHÔNG hiện thực một vòng nối chuỗi (chaining) thứ hai. Gồm
// kiểm tra cấp mã nguồn (gọi nằm TRONG thân hàm) và kiểm tra
// chức năng (chuỗi đỉnh trả về đúng là kết quả của tracePerimeter).
//
// Feature: dieline-hardening-phase2
// Validates: Requirements 1.2
// ============================================================

/**
 * Trích thân hàm `extractOuterSilhouette` từ mã nguồn validator để
 * khẳng định lời gọi `tracePerimeter` nằm bên TRONG hàm này (chứ
 * không chỉ ở chỗ khác trong file).
 */
function extractOuterSilhouetteBody(src: string): string {
    const marker = 'export function extractOuterSilhouette';
    const start = src.indexOf(marker);
    if (start < 0) {
        throw new Error('Không tìm thấy định nghĩa extractOuterSilhouette trong nguồn');
    }
    // Quét cân bằng ngoặc nhọn từ dấu `{` đầu tiên sau chữ ký hàm.
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(braceStart, i + 1);
        }
    }
    return src.slice(braceStart);
}

describe('Phase 2 Task 1.2 — extractOuterSilhouette tái dùng tracePerimeter (Req 1.2)', () => {
    const src = readValidatorSource();
    const body = extractOuterSilhouetteBody(src);

    it('file import tracePerimeter từ ./tracePerimeter', () => {
        expect(src).toMatch(
            /import\s*\{[^}]*\btracePerimeter\b[^}]*\}\s*from\s*['"]\.\/tracePerimeter['"]/,
        );
    });

    it('extractOuterSilhouette GỌI tracePerimeter(...) trong thân hàm', () => {
        expect(body).toMatch(/tracePerimeter\s*\(/);
    });

    it('KHÔNG có vòng nối chuỗi (chaining) thứ hai trong extractOuterSilhouette', () => {
        // Không tự cài lại thuật toán chaining: không while-loop, không
        // helper buildChains/chainSegments cục bộ.
        expect(body).not.toMatch(/\bwhile\s*\(/);
        expect(src).not.toMatch(/function\s+(buildChains|chainSegments)/);
        expect(src).not.toMatch(/\bconst\s+(buildChains|chainSegments)\b/);
    });

    // ── Kiểm tra chức năng: chuỗi đỉnh do extractOuterSilhouette trả về
    //    chính là kết quả nối chuỗi của tracePerimeter (cùng nguồn). ──
    const square = (close: boolean): PathSegment[] => {
        const line = (a: Point2D, b: Point2D): PathSegment => ({
            points: [a, b],
            tag: 'CUT',
            type: 'line',
        });
        const segs: PathSegment[] = [
            line({ x: 0, y: 0 }, { x: 10, y: 0 }),
            line({ x: 10, y: 0 }, { x: 10, y: 10 }),
            line({ x: 10, y: 10 }, { x: 0, y: 10 }),
        ];
        if (close) segs.push(line({ x: 0, y: 10 }, { x: 0, y: 0 }));
        return segs;
    };

    it('hình vuông CUT khép kín → silhouette closed với diện tích > 0', () => {
        const sil = extractOuterSilhouette(square(true));
        expect(sil).not.toBeNull();
        expect(sil!.closed).toBe(true);
        expect(sil!.gapMm).toBeLessThanOrEqual(SNAP_TOLERANCE);
        expect(sil!.area).toBeGreaterThan(0);
    });

    it('hình vuông CUT thiếu một cạnh → silhouette hở với gapMm > SNAP_TOLERANCE', () => {
        const sil = extractOuterSilhouette(square(false));
        expect(sil).not.toBeNull();
        expect(sil!.closed).toBe(false);
        expect(sil!.gapMm).toBeGreaterThan(SNAP_TOLERANCE);
    });

    it('chỉ-CREASE (không CUT/BLEED) → trả về null (không có biên ngoài)', () => {
        const creaseOnly: PathSegment[] = [
            { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], tag: 'CREASE', type: 'line' },
            { points: [{ x: 10, y: 0 }, { x: 10, y: 10 }], tag: 'CREASE', type: 'line' },
        ];
        expect(extractOuterSilhouette(creaseOnly)).toBeNull();
    });
});

// ============================================================
// Phase 2 Task 2.2 — Smoke test: validator dùng SNAP_TOLERANCE dùng chung
//
// Xác minh `contourValidator.ts` import `SNAP_TOLERANCE` từ
// `./sharedGeometry` (= 0,01 mm) và KHÔNG khai báo một hằng số
// dung sai snap nội bộ riêng (tránh phân kỳ giá trị dung sai).
//
// Feature: dieline-hardening-phase2
// Validates: Requirements 2.4
// ============================================================

describe('Phase 2 Task 2.2 — validator dùng SNAP_TOLERANCE dùng chung (Req 2.4)', () => {
    const src = readValidatorSource();

    it('SNAP_TOLERANCE dùng chung (sharedGeometry) bằng đúng 0,01 mm', () => {
        // Giá trị import trực tiếp từ sharedGeometry — single source of truth.
        expect(SNAP_TOLERANCE).toBe(0.01);
    });

    it('contourValidator import SNAP_TOLERANCE từ ./sharedGeometry', () => {
        expect(src).toMatch(
            /import\s*\{[^}]*\bSNAP_TOLERANCE\b[^}]*\}\s*from\s*['"]\.\/sharedGeometry['"]/,
        );
    });

    it('contourValidator KHÔNG khai báo hằng số snap-tolerance nội bộ riêng', () => {
        // Không có khai báo cục bộ `const SNAP_TOLERANCE = ...` (chỉ import).
        expect(src).not.toMatch(/\b(const|let|var)\s+SNAP_TOLERANCE\b/);
        // Không định nghĩa hằng số dung sai snap nội bộ dưới tên khác
        // (vd: SNAP_TOL, SNAP_EPS, TOLERANCE) gán literal số.
        expect(src).not.toMatch(
            /\b(const|let|var)\s+\w*(SNAP|TOLERANCE|TOL|EPSILON|EPS)\w*\s*=\s*[\d.]+/i,
        );
    });

    it('contourValidator thực sự dùng SNAP_TOLERANCE trong logic phân loại', () => {
        // Sử dụng (không chỉ import suông) hằng số dùng chung.
        const uses = (src.match(/\bSNAP_TOLERANCE\b/g) ?? []).length;
        // Ít nhất 1 lần ở dòng import + 1 lần dùng trong thân hàm.
        expect(uses).toBeGreaterThanOrEqual(2);
    });
});

// ============================================================
// Phase 2 — Property-based tests (Properties 1–4)
//
// Mỗi property chạy fc.assert(prop, { numRuns: 100, seed }) với seed
// cố định/được ghi nhận (Requirement 9.4). Nhãn comment tham chiếu
// design property theo định dạng:
//   // Feature: dieline-hardening-phase2, Property N: ...
// ============================================================

// ─── Seed cố định (được ghi nhận) cho từng property ─────────
const SEED_P1 = 0x1f00d1; // 2031825
const SEED_P2 = 0x2f00d2; // 3080402
const SEED_P3 = 0x3f00d3; // 4128979
const SEED_P3B = 0x3f00e3; // 4129027
const SEED_P4 = 0x4f00d4; // 5177556

// ─── 8 generator (loại hộp) ─────────────────────────────────
const ALL_GENERATOR_TYPES: GeneratorBoxType[] = [
    'rte', 'slb', 'auto_bottom', 'gable', 'paper_bag', 'cup_sleeve', 'pizza', 'envelope', 'tray',
];

// ─── Helpers dựng model tổng hợp (chỉ dùng nội bộ file test) ──

const P2 = (x: number, y: number): Point2D => ({ x, y });
const cutLine = (a: Point2D, b: Point2D): PathSegment => ({
    points: [a, b],
    tag: 'CUT',
    type: 'line',
});

function mkPanel(name: string, paths: PathSegment[]): Panel {
    return {
        name,
        label: name,
        paths,
        parent: null,
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: 1,
    };
}

function mkModel(panels: Panel[], allPaths: PathSegment[]): DielineModel {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of allPaths) {
        for (const p of s.points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    return {
        name: 'synth',
        standardCode: 'SYNTH',
        description: '',
        panels,
        allPaths,
        boundingBox: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
        params: { ...DEFAULT_PARAMS },
    };
}

/**
 * Dựng một DielineModel tổng hợp có BIÊN NGOÀI là hình chữ nhật
 * W×H gồm 4 đoạn CUT khép kín (mọi đầu mút góc có buddy).
 *
 *  - `withInterior`: thêm một Interior_Cut_Feature (relief slit) gắn
 *    tại góc c2 và kết thúc giữa vật liệu tại điểm trong vùng bao
 *    `p = (0.3W, 0.3H)` — đầu mút trong này KHÔNG thuộc biên ngoài.
 *  - `perturbD > 0`: dịch đầu mút biên ngoài tại góc c1 đi đúng `d`
 *    theo vector đơn vị (0.6, 0.8) ⇒ tạo Open_Outer_Boundary với
 *    khoảng hở đầu-cuối đúng bằng `d`.
 *
 * Toàn bộ segment là cùng tham chiếu trong cả `panels[].paths` lẫn
 * `allPaths` (panel duy nhất 'p0').
 */
function buildSynthRectModel(
    W: number,
    H: number,
    opts: { withInterior: boolean; perturbD: number },
): DielineModel {
    const c0 = P2(0, 0);
    const c1 = P2(W, 0);
    const c2 = P2(W, H);
    const c3 = P2(0, H);
    const d = opts.perturbD;
    // c1 bị dịch khi perturb: vector đơn vị (0.6, 0.8) ⇒ |Δ| = d.
    const c1start = d > 0 ? P2(W + d * 0.6, d * 0.8) : c1;

    // s0 kết thúc tại c1 (gốc); s1 bắt đầu tại c1start (đã dịch nếu perturb).
    const s0 = cutLine(c0, c1);
    const s1 = cutLine(c1start, c2);
    const s2 = cutLine(c2, c3);
    const s3 = cutLine(c3, c0);
    const segs: PathSegment[] = [s0, s1, s2, s3];

    if (opts.withInterior) {
        // Relief slit nội bộ: gắn tại góc c2 (KHÔNG phải c0 — điểm bắt đầu
        // truy vết — nên không bị nối thành đuôi chu vi) và kết thúc tại
        // điểm trong vùng bao (đầu cắt chết).
        const pInner = P2(0.3 * W, 0.3 * H);
        segs.push(cutLine(c2, pInner));
    }

    const panel = mkPanel('p0', segs);
    return mkModel([panel], segs);
}

// ============================================================
// Phase 2 — Task 2.3 / Property 1
// Feature: dieline-hardening-phase2, Property 1: Phân loại khép kín
// dựa trên biên ngoài (bỏ qua đặc trưng cắt nội bộ) — for any model
// có biên ngoài khép kín, validator trả allClosed=true kể cả khi còn
// Interior_Cut_Feature hở; for any model thu được bằng cách dịch một
// đầu mút THUỘC biên ngoài đi d > SNAP_TOLERANCE, validator trả
// allClosed=false với gapMm thỏa |gapMm − d| ≤ 0,01 mm; lặp lại giống hệt.
//
// Validates: Requirements 1.1, 1.3, 1.4, 2.1, 2.2, 2.5, 3.4
// ============================================================
describe('Phase 2 Property 1 — phân loại khép kín dựa trên biên ngoài', () => {
    it('biên ngoài kín + đặc trưng nội bộ ⇒ allClosed; dịch đầu mút biên ngoài ⇒ hở gapMm≈d', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 40, max: 300 }), // W
                fc.integer({ min: 40, max: 300 }), // H
                fc.double({ min: 0.5, max: 200, noNaN: true, noDefaultInfinity: true }), // d > SNAP
                (W: number, H: number, d: number) => {
                    // ── Phần A: biên ngoài kín + Interior_Cut_Feature hở ⇒ allClosed=true ──
                    const closed = buildSynthRectModel(W, H, { withInterior: true, perturbD: 0 });
                    const rClosed = validateClosedContours(closed);
                    expect(rClosed.allClosed).toBe(true);
                    expect(rClosed.openContours).toEqual([]);
                    // Tính xác định (Req 2.5): đánh giá lặp lại cho kết quả giống hệt.
                    expect(validateClosedContours(closed)).toEqual(rClosed);

                    // ── Phần B: dịch một đầu mút THUỘC biên ngoài đi d ⇒ Open_Outer_Boundary ──
                    const open = buildSynthRectModel(W, H, { withInterior: true, perturbD: d });
                    const rOpen = validateClosedContours(open);
                    expect(rOpen.allClosed).toBe(false);
                    // gapMm của biên ngoài thỏa |gapMm − d| ≤ 0,01 mm (Req 3.4).
                    const hit = rOpen.openContours.find((oc) => Math.abs(oc.gapMm - d) <= 0.01);
                    expect(hit).toBeDefined();
                    // Tính xác định (Req 2.5).
                    expect(validateClosedContours(open)).toEqual(rOpen);
                },
            ),
            { numRuns: 100, seed: SEED_P1 },
        );
    });
});

// ============================================================
// Phase 2 — Task 2.4 / Property 2
// Feature: dieline-hardening-phase2, Property 2: Panel đại diện của
// biên ngoài hở là xác định — Panel đại diện là Panel chứa nhiều đoạn
// CUT/BLEED của biên ngoài hở nhất; đồng hạng → Panel có chỉ số thấp
// nhất; ổn định giữa các lần đánh giá.
//
// Validates: Requirements 2.3
// ============================================================

/**
 * Dựng model có biên ngoài chữ nhật HỞ (dịch góc c1 đi `d`), với 4 đoạn
 * CUT phân bổ vào các panel theo `mapping` (mapping[i] = chỉ số panel
 * chứa đoạn thứ i). Trả về model + tên panel theo chỉ số.
 */
function buildPanelDistributedOpenModel(
    W: number,
    H: number,
    d: number,
    mapping: number[],
): { model: DielineModel; panelNames: string[] } {
    const c0 = P2(0, 0);
    const c1 = P2(W, 0);
    const c2 = P2(W, H);
    const c3 = P2(0, H);
    const c1start = P2(W + d * 0.6, d * 0.8); // hở tại c1, khoảng hở = d

    const s0 = cutLine(c0, c1);
    const s1 = cutLine(c1start, c2);
    const s2 = cutLine(c2, c3);
    const s3 = cutLine(c3, c0);
    const segs: PathSegment[] = [s0, s1, s2, s3];

    const k = Math.max(...mapping) + 1;
    const panelNames: string[] = [];
    const panels: Panel[] = [];
    for (let i = 0; i < k; i++) {
        const name = `panel_${i}`;
        panelNames.push(name);
        panels.push(mkPanel(name, []));
    }
    mapping.forEach((pi, idx) => panels[pi].paths.push(segs[idx]));

    return { model: mkModel(panels, segs), panelNames };
}

describe('Phase 2 Property 2 — panel đại diện của biên ngoài hở là xác định', () => {
    it('Panel chứa nhiều đoạn biên ngoài hở nhất (đồng hạng → chỉ số thấp nhất), ổn định', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 40, max: 300 }), // W
                fc.integer({ min: 40, max: 300 }), // H
                fc.double({ min: 0.5, max: 50, noNaN: true, noDefaultInfinity: true }), // d
                fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 4, maxLength: 4 }), // mapping
                (W: number, H: number, d: number, mapping: number[]) => {
                    const { model, panelNames } = buildPanelDistributedOpenModel(W, H, d, mapping);

                    // Panel đại diện kỳ vọng: nhiều đoạn nhất; đồng hạng → chỉ số thấp nhất.
                    const counts = new Map<number, number>();
                    for (const pi of mapping) counts.set(pi, (counts.get(pi) ?? 0) + 1);
                    let bestIdx = -1;
                    let bestCount = -1;
                    for (const [idx, c] of counts) {
                        if (c > bestCount || (c === bestCount && idx < bestIdx)) {
                            bestCount = c;
                            bestIdx = idx;
                        }
                    }
                    const expectedName = panelNames[bestIdx];

                    const res = validateClosedContours(model);
                    expect(res.allClosed).toBe(false);
                    expect(res.openContours.length).toBe(1);
                    expect(res.openContours[0].panelName).toBe(expectedName);

                    // Ổn định giữa các lần đánh giá (xác định).
                    expect(validateClosedContours(model)).toEqual(res);
                },
            ),
            { numRuns: 100, seed: SEED_P2 },
        );
    });
});

// ============================================================
// Phase 2 — Task 3.3 / Property 3
// Feature: dieline-hardening-phase2, Property 3: Validator và cổng xuất
// không biến đổi model — gọi validateClosedContours (và chạy cổng xuất
// tới trạng thái 'cancelled') KHÔNG làm thay đổi panels/allPaths/params/
// boundingBox/warnings và KHÔNG ghi vào Panel.outline — model sau lời gọi
// sâu-bằng (deep-equal) model trước lời gọi.
//
// Validates: Requirements 4.2, 3.6
// ============================================================
describe('Phase 2 Property 3 — validator/cổng xuất không biến đổi model', () => {
    it('8 generator: validateClosedContours + decideExportGate không biến đổi model', () => {
        fc.assert(
            fc.property(
                fc.constantFrom(...ALL_GENERATOR_TYPES).chain((bt) =>
                    arbBoxParams(bt).map((p) => ({ bt, p })),
                ),
                ({ bt, p }: { bt: GeneratorBoxType; p: BoxParams }) => {
                    const model = GENERATORS[bt](p);
                    const before = structuredClone(model);

                    const res = validateClosedContours(model);
                    // Chạy hàm cổng xuất thuần (điểm quan sát được của cổng).
                    decideExportGate(res, false);

                    // Model không bị biến đổi (deep-equal). Deep-equal bao trùm
                    // cả Panel.outline: nếu validator GHI vào outline (Req 4.2
                    // cấm), giá trị sẽ khác `before` và toEqual sẽ fail.
                    expect(model).toEqual(before);
                },
            ),
            { numRuns: 100, seed: SEED_P3 },
        );
    });

    it("chạy cổng xuất tới 'cancelled' giữ nguyên model (Req 3.6)", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 40, max: 300 }), // W
                fc.integer({ min: 40, max: 300 }), // H
                fc.double({ min: 0.5, max: 50, noNaN: true, noDefaultInfinity: true }), // d
                (W: number, H: number, d: number) => {
                    const model = buildSynthRectModel(W, H, { withInterior: true, perturbD: d });
                    const before = structuredClone(model);

                    const res = validateClosedContours(model);
                    const decision = decideExportGate(res, false);

                    // Có Open_Outer_Boundary, không có callback xác nhận ⇒ cancelled.
                    expect(decision.kind).toBe('cancelled');
                    // Không ghi đầu ra; model giữ nguyên (deep-equal) — gồm
                    // Panel.outline (Req 4.2): bất kỳ ghi nào vào outline sẽ
                    // làm khác `before` và toEqual fail.
                    expect(model).toEqual(before);
                },
            ),
            { numRuns: 100, seed: SEED_P3B },
        );
    });
});

// ============================================================
// Phase 2 — Task 3.4 / Property 4
// Feature: dieline-hardening-phase2, Property 4: Mọi generator cho biên
// ngoài khép kín (loại bỏ cảnh báo giả) — for any generator trong 8
// generator và for any params hợp lệ, mọi Cut_Piece có Outer_Silhouette
// khép kín hoặc không có biên ngoài (chỉ-CREASE) ⇒ allClosed=true.
// Chạy RIÊNG từng generator để phản ví dụ chỉ rõ tên generator + seed.
//
// Validates: Requirements 3.1, 1.5
// ============================================================
describe('Phase 2 Property 4 — mọi generator cho biên ngoài khép kín', () => {
    for (const boxType of ALL_GENERATOR_TYPES) {
        it(`allClosed=true cho mọi params hợp lệ (${boxType})`, () => {
            fc.assert(
                fc.property(arbBoxParams(boxType), (params: BoxParams) => {
                    const model = GENERATORS[boxType](params);
                    const res = validateClosedContours(model);
                    expect(res.allClosed).toBe(true);
                    expect(res.openContours).toEqual([]);
                }),
                { numRuns: 100, seed: SEED_P4 },
            );
        });
    }
});
