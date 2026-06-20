// ============================================================
// Example test cho CỔNG XÁC NHẬN XUẤT FILE (Export Gate)
//
// Kiểm tra luồng cổng kiểm tra biên dạng khép kín trong
// `downloadPDF` (exportPDF.ts):
//   - Model toàn biên kín → ghi file trực tiếp, KHÔNG gọi callback
//     xác nhận (Requirement 1.8).
//   - Model có biên hở + confirmOpenContours resolve false → KHÔNG
//     ghi file (Requirement 1.4).
//   - Model có biên hở + confirmOpenContours resolve true → ghi file,
//     callback nhận danh sách cảnh báo (panelName/gapMm) (Req 1.3, 1.4).
//   - Model có biên hở + KHÔNG có callback → coi như chưa xác nhận,
//     KHÔNG ghi file (Requirement 1.4).
//
// _Requirements: 1.3, 1.4, 1.8_
//
// jsPDF / svg2pdf.js / sonner được mock để việc "ghi file" trở nên
// quan sát được qua spy trên `doc.save`. DOMParser được stub vì test
// chạy trong môi trường node (không jsdom).
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DielineModel, PathSegment, Point2D, DEFAULT_PARAMS } from './types';

// ── Mock PDF pipeline: spy trên save/svg/setProperties ──
const { saveMock, svgMock, setPropertiesMock } = vi.hoisted(() => ({
    saveMock: vi.fn(),
    svgMock: vi.fn().mockResolvedValue(undefined),
    setPropertiesMock: vi.fn(),
}));

vi.mock('jspdf', () => ({
    jsPDF: class {
        svg = svgMock;
        setProperties = setPropertiesMock;
        save = saveMock;
    },
}));

// svg2pdf.js chỉ được import side-effect → mock rỗng.
vi.mock('svg2pdf.js', () => ({}));

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
import { downloadPDF } from './exportPDF';

// ── Helpers ──

const P = (x: number, y: number): Point2D => ({ x, y });

/** 4 đoạn CUT tạo thành hình vuông KHÉP KÍN (gap đầu-cuối = 0). */
function closedSquareSegments(): PathSegment[] {
    return [
        { points: [P(0, 0), P(10, 0)], tag: 'CUT', type: 'line' },
        { points: [P(10, 0), P(10, 10)], tag: 'CUT', type: 'line' },
        { points: [P(10, 10), P(0, 10)], tag: 'CUT', type: 'line' },
        { points: [P(0, 10), P(0, 0)], tag: 'CUT', type: 'line' },
    ];
}

/** 3 đoạn CUT tạo thành biên HỞ (thiếu cạnh đóng → gap ~10mm). */
function openSegments(): PathSegment[] {
    return [
        { points: [P(0, 0), P(10, 0)], tag: 'CUT', type: 'line' },
        { points: [P(10, 0), P(10, 10)], tag: 'CUT', type: 'line' },
        { points: [P(10, 10), P(0, 10)], tag: 'CUT', type: 'line' },
    ];
}

function makeModel(segments: PathSegment[]): DielineModel {
    return {
        name: 'Test Box',
        standardCode: 'TEST-001',
        description: 'test',
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
        // cup_sleeve → buildDimensionSvg trả về '' (đơn giản hoá luồng ghi file).
        boundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 },
        params: { ...DEFAULT_PARAMS, boxType: 'cup_sleeve' },
        warnings: [],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    // Stub DOMParser cho môi trường node (luồng ghi file dùng new DOMParser()).
    (globalThis as any).DOMParser = class {
        parseFromString(_str: string, _type: string) {
            return { documentElement: {} };
        }
    };
});

describe('downloadPDF — cổng xác nhận xuất file', () => {
    it('model toàn biên kín → ghi file trực tiếp, KHÔNG gọi callback xác nhận (Req 1.8)', async () => {
        const confirm = vi.fn().mockResolvedValue(true);

        await downloadPDF(makeModel(closedSquareSegments()), 'closed.pdf', confirm);

        expect(confirm).not.toHaveBeenCalled();
        expect(saveMock).toHaveBeenCalledTimes(1);
        expect(saveMock).toHaveBeenCalledWith('closed.pdf');
        // Không cảnh báo vì không có biên hở.
        expect(toastMock.warning).not.toHaveBeenCalled();
    });

    it('biên hở + confirm resolve FALSE → KHÔNG ghi file (Req 1.4)', async () => {
        const confirm = vi.fn().mockResolvedValue(false);

        await downloadPDF(makeModel(openSegments()), 'open.pdf', confirm);

        expect(confirm).toHaveBeenCalledTimes(1);
        expect(saveMock).not.toHaveBeenCalled();
        // Người dùng được cảnh báo trước khi quyết định (Req 1.3).
        expect(toastMock.warning).toHaveBeenCalledTimes(1);
    });

    it('biên hở + confirm resolve TRUE → ghi file; callback nhận danh sách cảnh báo (Req 1.3, 1.4)', async () => {
        const confirm = vi.fn().mockResolvedValue(true);

        await downloadPDF(makeModel(openSegments()), 'open.pdf', confirm);

        expect(confirm).toHaveBeenCalledTimes(1);

        // Callback nhận danh sách cảnh báo biên hở.
        const warnings = confirm.mock.calls[0][0];
        expect(Array.isArray(warnings)).toBe(true);
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toHaveProperty('panelName', 'panel1');
        expect(warnings[0]).toHaveProperty('gapMm');
        expect(warnings[0].gapMm).toBeGreaterThan(0.01);

        expect(toastMock.warning).toHaveBeenCalledTimes(1);
        expect(saveMock).toHaveBeenCalledTimes(1);
        expect(saveMock).toHaveBeenCalledWith('open.pdf');
    });

    it('biên hở + KHÔNG có callback xác nhận → KHÔNG ghi file (Req 1.4)', async () => {
        await downloadPDF(makeModel(openSegments()));

        expect(saveMock).not.toHaveBeenCalled();
        expect(toastMock.warning).toHaveBeenCalledTimes(1);
    });
});
