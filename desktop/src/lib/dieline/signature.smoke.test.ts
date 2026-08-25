// ============================================================
// signature.smoke.test.ts — Smoke test chữ ký công khai
// (Public API backward-compatibility)
//
// Task 10.2 — **Validates: Requirements 4.3, 8.4**
//
// Xác minh ba API công khai mà Giai đoạn 2 chạm tới GIỮ NGUYÊN chữ
// ký tương thích ngược một cách ĐO ĐƯỢC:
//   - `validateClosedContours(model)` → `ContourValidationResult`
//   - `downloadPDF(model, filename?, confirmOpenContours?)` → `Promise<void>`
//   - `calculateNesting(bbox, config, params?)` → `NestingResult`
//
// Ba tầng kiểm tra:
//   1. COMPILE-TIME (type-level): gán mỗi hàm vào một biến có KIỂU
//      chữ ký kỳ vọng. Nếu số/kiểu tham số bắt buộc hoặc kiểu trả về
//      đổi theo cách phá vỡ, `tsc --noEmit` sẽ phát sinh lỗi TS →
//      đây là cách "0 lỗi TS mới" được khẳng định tĩnh (Req 4.3, 8.4).
//   2. RUNTIME (arity + return shape): gọi với đối số hợp lệ, kiểm
//      tra số tham số bắt buộc (`Function.length`) và HÌNH DẠNG kết
//      quả trả về khớp kiểu công khai.
//   3. STATIC SOURCE: đọc nguồn để xác nhận tham số mới (nếu có) là
//      TÙY CHỌN (`filename?`, `confirmOpenContours?`, `params?`) — tức
//      mã gọi hiện có không phải sửa (Req 4.3, 8.4).
//
// jsPDF / svg2pdf.js / sonner được mock và DOMParser được stub để
// `downloadPDF` chạy được trong môi trường node mà không thực sự ghi
// file (chỉ quan tâm KIỂU TRẢ VỀ `Promise<void>`).
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
    DielineModel,
    BoxParams,
    DEFAULT_PARAMS,
    PathSegment,
    Point2D,
} from './types';
import {
    NestingConfig,
    NestingResult,
    DEFAULT_NESTING_CONFIG,
} from './nestingTypes';

// ── Mock PDF pipeline (jsPDF / svg2pdf.js) ──
const { outputMock, svgMock, setPropertiesMock } = vi.hoisted(() => ({
    outputMock: vi.fn(() => new ArrayBuffer(8)),
    svgMock: vi.fn().mockResolvedValue(undefined),
    setPropertiesMock: vi.fn(),
}));

vi.mock('jspdf', () => ({
    jsPDF: class {
        svg = svgMock;
        setProperties = setPropertiesMock;
        output = outputMock;
    },
}));

vi.mock('svg2pdf.js', () => ({}));

// Ghi file ra đĩa tách sang helper `saveJsPdfDoc` — mock để không đụng Tauri fs.
vi.mock('./saveJsPdfDoc', () => ({
    saveJsPdfDoc: vi.fn().mockResolvedValue({ kind: 'saved' }),
}));

// ── Mock toast (sonner) ──
const { toastMock } = vi.hoisted(() => ({
    toastMock: {
        warning: vi.fn(),
        loading: vi.fn(() => 'toast-id'),
        success: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('sonner', () => ({ toast: toastMock }));

// Import SAU khi khai báo mock (vi.mock được hoisted).
import {
    validateClosedContours,
    ContourValidationResult,
    OpenContourWarning,
} from './contourValidator';
import { downloadPDF } from './exportPDF';
import { calculateNesting } from './nestingEngine';

// ── Helpers ──

const P = (x: number, y: number): Point2D => ({ x, y });

/** 4 đoạn CUT tạo thành hình vuông KHÉP KÍN (mọi biên ngoài kín). */
function closedSquareSegments(): PathSegment[] {
    return [
        { points: [P(0, 0), P(10, 0)], tag: 'CUT', type: 'line' },
        { points: [P(10, 0), P(10, 10)], tag: 'CUT', type: 'line' },
        { points: [P(10, 10), P(0, 10)], tag: 'CUT', type: 'line' },
        { points: [P(0, 10), P(0, 0)], tag: 'CUT', type: 'line' },
    ];
}

function makeClosedModel(): DielineModel {
    const segments = closedSquareSegments();
    return {
        name: 'Sig Smoke Box',
        standardCode: 'SIG-001',
        description: 'signature smoke test',
        panels: [
            {
                name: 'panel1',
                label: 'Mặt 1',
                paths: segments,
                parent: null,
                pivotEdge: null,
                foldAngle: 0,
                foldDirection: 1,
            },
        ],
        allPaths: segments,
        // cup_sleeve → buildDimensionSvg trả '' (đơn giản hoá luồng ghi file).
        boundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 },
        params: { ...DEFAULT_PARAMS, boxType: 'cup_sleeve' },
        warnings: [],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    // Stub DOMParser cho môi trường node (luồng ghi file dùng new DOMParser()).
    vi.stubGlobal('DOMParser', class {
        parseFromString() {
            return { documentElement: {} };
        }
    });
});

// ============================================================
// Tầng 1 — COMPILE-TIME: gán hàm vào biến có kiểu chữ ký kỳ vọng.
// Nếu chữ ký công khai đổi (bỏ/đổi tham số bắt buộc, đổi kiểu trả về,
// biến tham số tùy chọn thành bắt buộc), các gán dưới đây sẽ KHÔNG
// biên dịch → `tsc --noEmit` báo lỗi TS (Req 4.3, 8.4).
// ============================================================

/** Chữ ký kỳ vọng của `validateClosedContours`. */
type ValidateClosedContoursSig = (model: DielineModel) => ContourValidationResult;

/** Chữ ký kỳ vọng của `downloadPDF` (filename + callback là TÙY CHỌN). */
type DownloadPDFSig = (
    model: DielineModel,
    filename?: string,
    confirmOpenContours?: (warnings: OpenContourWarning[]) => Promise<boolean>,
) => Promise<void>;

/** Chữ ký kỳ vọng của `calculateNesting` (params là TÙY CHỌN). */
type CalculateNestingSig = (
    bbox: { width: number; height: number },
    config: NestingConfig,
    params?: BoxParams,
) => NestingResult;

// Gán type-checked — đây là điểm khẳng định "0 lỗi TS mới" (Req 4.3).
const _validateSig: ValidateClosedContoursSig = validateClosedContours;
const _downloadSig: DownloadPDFSig = downloadPDF;
const _nestingSig: CalculateNestingSig = calculateNesting;

describe('signature smoke — chữ ký công khai gán được vào kiểu kỳ vọng (Req 4.3, 8.4)', () => {
    it('các tham chiếu hàm type-checked tồn tại và là function', () => {
        expect(typeof _validateSig).toBe('function');
        expect(typeof _downloadSig).toBe('function');
        expect(typeof _nestingSig).toBe('function');
    });
});

// ============================================================
// Tầng 2 — RUNTIME: số tham số bắt buộc (arity) + hình dạng trả về.
// ============================================================

describe('signature smoke — số tham số bắt buộc (Function.length)', () => {
    it('validateClosedContours yêu cầu đúng 1 tham số bắt buộc (model)', () => {
        expect(validateClosedContours.length).toBe(1);
    });

    it('downloadPDF chỉ yêu cầu `model`; `filename`/`confirmOpenContours` là tùy chọn', () => {
        // Tổng tham số khai báo = 3 (model, filename?, confirmOpenContours?);
        // chỉ `model` bắt buộc → gọi được với 1 đối số (kiểm ở test return-shape).
        expect(downloadPDF.length).toBe(3);
    });

    it('calculateNesting yêu cầu `bbox` + `config`; `params` là tùy chọn', () => {
        // Tổng tham số khai báo = 3 (bbox, config, params?); 2 đầu bắt buộc.
        expect(calculateNesting.length).toBe(3);
    });
});

describe('signature smoke — hình dạng kiểu trả về khớp API công khai (Req 4.3, 8.4)', () => {
    it('validateClosedContours(model) → ContourValidationResult { allClosed, openContours }', () => {
        const result = validateClosedContours(makeClosedModel());

        expect(result).toBeTypeOf('object');
        expect(result).toHaveProperty('allClosed');
        expect(typeof result.allClosed).toBe('boolean');
        expect(result).toHaveProperty('openContours');
        expect(Array.isArray(result.openContours)).toBe(true);
        // Model vuông kín → không biên ngoài hở.
        expect(result.allClosed).toBe(true);
        expect(result.openContours).toHaveLength(0);
    });

    it('calculateNesting(bbox, config) → NestingResult với đầy đủ trường công khai', () => {
        const bbox = { width: 100, height: 60 };
        const result: NestingResult = calculateNesting(bbox, DEFAULT_NESTING_CONFIG);

        // Hình dạng kết quả công khai (nestingTypes.NestingResult).
        expect(Array.isArray(result.positions)).toBe(true);
        expect(typeof result.countPerSheet).toBe('number');
        expect(typeof result.rows).toBe('number');
        expect(typeof result.cols).toBe('number');
        expect(typeof result.utilization).toBe('number');
        expect(result.usableArea).toMatchObject({
            width: expect.any(Number),
            height: expect.any(Number),
        });
        expect(result.actualSheet).toMatchObject({
            width: expect.any(Number),
            height: expect.any(Number),
        });
        expect(result.cellSize).toMatchObject({
            width: expect.any(Number),
            height: expect.any(Number),
        });
        expect(typeof result.label).toBe('string');
        // superTile: SuperTileInfo | null
        expect(result.superTile === null || typeof result.superTile === 'object').toBe(true);

        // Mỗi vị trí khuôn có hình dạng PlacedDieline { x, y, rotation }.
        for (const pos of result.positions) {
            expect(typeof pos.x).toBe('number');
            expect(typeof pos.y).toBe('number');
            expect([0, 90, 180, 270]).toContain(pos.rotation);
        }
    });

    it('calculateNesting chấp nhận `params` tùy chọn (mã gọi cũ không cần sửa)', () => {
        const bbox = { width: 100, height: 60 };
        // Gọi kèm params? — vẫn hợp lệ, trả NestingResult.
        const withParams = calculateNesting(bbox, DEFAULT_NESTING_CONFIG, DEFAULT_PARAMS);
        expect(typeof withParams.countPerSheet).toBe('number');
    });

    it('downloadPDF(model) → Promise<void>; gọi được với CHỈ `model` (resolve undefined)', async () => {
        const ret = downloadPDF(makeClosedModel());

        // Kiểu trả về là Promise.
        expect(ret).toBeInstanceOf(Promise);

        // void ⇒ resolve undefined; không ném (luồng ghi file đã được mock).
        const resolved = await ret;
        expect(resolved).toBeUndefined();
    });

    it('downloadPDF(model, filename, confirmOpenContours) — gọi đủ 3 đối số vẫn Promise<void>', async () => {
        const confirm = vi.fn().mockResolvedValue(true);
        const ret = downloadPDF(makeClosedModel(), 'sig.pdf', confirm);

        expect(ret).toBeInstanceOf(Promise);
        const resolved = await ret;
        expect(resolved).toBeUndefined();
    });
});

// ============================================================
// Tầng 3 — STATIC SOURCE: tham số mới (nếu có) phải TÙY CHỌN,
// tham số/kiểu trả về bắt buộc không đổi (Req 4.3, 8.4).
// ============================================================

/** Đọc nguồn một file cạnh test, bền vững với thư mục làm việc. */
function readSibling(fileName: string): string {
    const candidates: string[] = [];
    try {
        candidates.push(fileURLToPath(new URL(`./${fileName}`, import.meta.url)));
    } catch {
        // bỏ qua nếu import.meta.url không resolve được
    }
    candidates.push(resolve(process.cwd(), `src/lib/dieline/${fileName}`));
    candidates.push(resolve(process.cwd(), `desktop/src/lib/dieline/${fileName}`));

    for (const path of candidates) {
        if (existsSync(path)) {
            return readFileSync(path, 'utf-8');
        }
    }
    throw new Error(`Không tìm thấy ${fileName} trong các ứng viên:\n${candidates.join('\n')}`);
}

describe('signature smoke — nguồn giữ tham số tùy chọn & kiểu trả về (Req 4.3, 8.4)', () => {
    it('contourValidator.ts: validateClosedContours(model: DielineModel): ContourValidationResult', () => {
        const src = readSibling('contourValidator.ts');
        expect(src).toMatch(
            /export function validateClosedContours\(\s*model:\s*DielineModel,?\s*\):\s*ContourValidationResult/,
        );
    });

    it('exportPDF.ts: downloadPDF giữ filename? + confirmOpenContours? tùy chọn, trả Promise<void>', () => {
        const src = readSibling('exportPDF.ts');
        // `model` bắt buộc, hai tham số sau là tùy chọn (dấu `?`), trả Promise<void>.
        expect(src).toMatch(/model:\s*DielineModel,/);
        expect(src).toMatch(/filename\?:\s*string,/);
        expect(src).toMatch(/confirmOpenContours\?:\s*\(/);
        expect(src).toMatch(/\):\s*Promise<void>/);
    });

    it('nestingEngine.ts: calculateNesting giữ bbox + config bắt buộc, params? tùy chọn, trả NestingResult', () => {
        const src = readSibling('nestingEngine.ts');
        expect(src).toMatch(/export function calculateNesting\(/);
        expect(src).toMatch(/bbox:\s*BBox,/);
        expect(src).toMatch(/config:\s*NestingConfig,/);
        expect(src).toMatch(/params\?:\s*BoxParams,?/);
        expect(src).toMatch(/\):\s*NestingResult/);
    });
});
