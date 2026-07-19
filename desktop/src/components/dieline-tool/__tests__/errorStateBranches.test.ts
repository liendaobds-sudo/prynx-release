// @vitest-environment jsdom
//
// ============================================================
// errorStateBranches.test.ts — Mockup 3D Realism (Task 11.4)
//
// Unit test các NHÁNH LỖI / TRẠNG THÁI kiểm được mà không cần
// render WebGL đầy đủ:
//   • HDRI nạp lỗi → hdriStatus = 'failed' (Yêu cầu 3.6)
//   • Ảnh nghệ thuật nạp lỗi (url → null) giữ nguyên scale/offset (Yêu cầu 5.9)
//   • Kích thước xuất vượt giới hạn → từ chối, giữ cảnh (Yêu cầu 6.7/6.8 ↔ 6.4)
//   • Đổi preset nền/sàn và giữ nguyên đến khi đổi (Yêu cầu 7.4)
//   • Trình duyệt không hỗ trợ WebGL → detect trả về false (Yêu cầu 8.4)
//
// Lớp logic thuần + store Zustand được kiểm trực tiếp; lớp render
// R3F (useSceneExport/EnvironmentRig) chỉ có nhánh lỗi thuần được
// kiểm gián tiếp qua hàm thuần (computeExportSize) và guarantee store.
//
// _Requirements: 3.6, 5.9, 6.7, 6.8, 7.4, 8.4_
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useMockupStore } from '../../../store/useMockupStore';
import {
    computeExportSize,
    MAX_EXPORT_PX,
} from '../../../lib/mockup3d/exportSizing';
import { detectWebGLSupport } from '../useWebGLSupport';
import type { ArtworkTransform } from '../../../lib/mockup3d/types';

// Lấy state/action thuận tiện ngoài React.
const store = () => useMockupStore.getState();

// Reset store về trạng thái khởi tạo trước mỗi test để cách ly.
beforeEach(() => {
    store().resetMockup();
});

// ──────────────────────────────────────────────────────────────────────────
// Yêu cầu 8.4 — WebGL không hỗ trợ
// ──────────────────────────────────────────────────────────────────────────

describe('Yêu cầu 8.4 — phát hiện WebGL không hỗ trợ', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('detectWebGLSupport trả về false khi canvas.getContext trả về null', () => {
        // Giả lập canvas có getContext luôn trả về null (GPU bị chặn / WebGL tắt).
        const fakeCanvas = {
            getContext: vi.fn().mockReturnValue(null),
        } as unknown as HTMLCanvasElement;
        const spy = vi
            .spyOn(document, 'createElement')
            .mockReturnValue(fakeCanvas as unknown as HTMLElement);

        expect(detectWebGLSupport()).toBe(false);
        // Đã thử cả 'webgl' và 'experimental-webgl'.
        expect(fakeCanvas.getContext).toHaveBeenCalled();
        spy.mockRestore();
    });

    it('detectWebGLSupport không ném lỗi khi getContext ném exception', () => {
        const fakeCanvas = {
            getContext: vi.fn(() => {
                throw new Error('WebGL disabled');
            }),
        } as unknown as HTMLCanvasElement;
        vi.spyOn(document, 'createElement').mockReturnValue(
            fakeCanvas as unknown as HTMLElement,
        );

        expect(() => detectWebGLSupport()).not.toThrow();
        expect(detectWebGLSupport()).toBe(false);
    });

    it('store: cờ webglSupported mặc định true và có thể đặt false (UI fallback)', () => {
        expect(store().webglSupported).toBe(true);
        store().setWebglSupported(false);
        expect(store().webglSupported).toBe(false);
        store().setWebglSupported(true);
        expect(store().webglSupported).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Yêu cầu 3.6 — HDRI nạp lỗi → hdriStatus = 'failed'
// ──────────────────────────────────────────────────────────────────────────

describe('Yêu cầu 3.6 — trạng thái nạp HDRI', () => {
    it('hdriStatus khởi tạo là loading', () => {
        expect(store().hdriStatus).toBe('loading');
    });

    it('hdriStatus chuyển sang failed khi nạp HDRI lỗi/quá thời gian', () => {
        store().setHdriStatus('failed');
        expect(store().hdriStatus).toBe('failed');
    });

    it('hdriStatus có thể chuyển loading → ready → failed', () => {
        store().setHdriStatus('ready');
        expect(store().hdriStatus).toBe('ready');
        store().setHdriStatus('failed');
        expect(store().hdriStatus).toBe('failed');
    });

    it('đổi hdriPreset không tự đặt lại trạng thái failed (tách biệt)', () => {
        store().setHdriStatus('failed');
        store().setHdriPreset('studio-warm');
        expect(store().hdriPreset).toBe('studio-warm');
        expect(store().hdriStatus).toBe('failed');
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Yêu cầu 7.4 — đổi preset nền/sàn, giữ nguyên đến khi đổi
// ──────────────────────────────────────────────────────────────────────────

describe('Yêu cầu 7.4 — preset nền/sàn', () => {
    it('đổi backgroundPreset cập nhật và lưu giá trị mới', () => {
        const initial = store().backgroundPreset; // mặc định studio trắng sạch
        // Đổi sang một preset KHÁC mặc định để kiểm tra cập nhật & khác giá trị đầu.
        store().setBackgroundPreset('studio-dark');
        expect(store().backgroundPreset).toBe('studio-dark');
        expect(store().backgroundPreset).not.toBe(initial);
    });

    it('mockup mặc định sạch và chỉ hiện lớp kỹ thuật khi người dùng bật', () => {
        expect(store().backgroundPreset).toBe('studio-white');
        expect(store().showTechnicalLines).toBe(false);
        expect(store().showFloorGrid).toBe(false);

        store().setShowTechnicalLines(true);
        store().setShowFloorGrid(true);
        expect(store().showTechnicalLines).toBe(true);
        expect(store().showFloorGrid).toBe(true);
    });
    it('backgroundPreset giữ nguyên cho đến khi chọn preset khác', () => {
        store().setBackgroundPreset('gradient-gray');
        // Thay đổi state khác không ảnh hưởng nền.
        store().setCameraPreset('top');
        store().setShowDimensions(true);
        expect(store().backgroundPreset).toBe('gradient-gray');
        // Đổi sang preset khác mới thay đổi.
        store().setBackgroundPreset('studio-white');
        expect(store().backgroundPreset).toBe('studio-white');
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Yêu cầu 5.9 — ảnh nghệ thuật nạp lỗi giữ nguyên scale/offset
// ──────────────────────────────────────────────────────────────────────────

describe('Yêu cầu 5.9 — lỗi nạp ảnh nghệ thuật bảo toàn transform', () => {
    it('đặt url ảnh ngoài về null (lỗi nạp) giữ nguyên transform đã cấu hình', () => {
        const transform: ArtworkTransform = { scalePct: 250, offsetXPct: 40, offsetYPct: -30, rotationDeg: 0 };
        store().setOuterArtworkUrl('blob:artwork-outer');
        store().setOuterArtworkTransform(transform);

        // Mô phỏng lỗi nạp: component báo lỗi, đặt url = null.
        store().setOuterArtworkUrl(null);

        const outer = store().artwork.outer;
        expect(outer.url).toBeNull();
        // Production chuẩn hoá transform qua clampArtworkTransform (bổ sung flipH/flipV
        // mặc định). Ý định test là BẢO TOÀN các trường đã cấu hình khi lỗi nạp ảnh,
        // nên so khớp bằng toMatchObject (các trường khai báo phải còn nguyên).
        expect(outer.transform).toMatchObject(transform);
    });

    it('đặt url ảnh trong về null giữ nguyên transform mặt trong', () => {
        const transform: ArtworkTransform = { scalePct: 75, offsetXPct: -10, offsetYPct: 20, rotationDeg: 0 };
        store().setInnerArtworkEnabled(true);
        store().setInnerArtworkUrl('blob:artwork-inner');
        store().setInnerArtworkTransform(transform);

        store().setInnerArtworkUrl(null);

        const inner = store().artwork.inner;
        expect(inner.url).toBeNull();
        expect(inner.enabled).toBe(true);
        // Bảo toàn các trường transform đã cấu hình (production chuẩn hoá thêm flipH/flipV).
        expect(inner.transform).toMatchObject(transform);
    });

    it('transform ngoài miền được clamp về biên gần nhất (giữ render hợp lệ)', () => {
        store().setOuterArtworkTransform({ scalePct: 5000, offsetXPct: 999, offsetYPct: -999 });
        const t = store().artwork.outer.transform;
        expect(t.scalePct).toBe(1000); // clamp về trần
        expect(t.offsetXPct).toBe(100);
        expect(t.offsetYPct).toBe(-100);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Yêu cầu 6.4 / 6.7 / 6.8 — giới hạn & nhánh lỗi xuất
// ──────────────────────────────────────────────────────────────────────────

describe('Yêu cầu 6.4/6.7 — kích thước xuất vượt giới hạn bị từ chối', () => {
    it('computeExportSize từ chối khi vượt 16384 px (giữ cảnh, kèm reason)', () => {
        // 4096 * 4 = 16384 (vừa biên, hợp lệ); 5000 * 4 = 20000 (vượt).
        const res = computeExportSize(5000, 1080, 4);
        expect(res.ok).toBe(false);
        expect(res.reason).toBeTruthy();
        // Vẫn báo cáo kích thước đã tính để chẩn đoán, không kết xuất.
        expect(res.width).toBe(20000);
    });

    it('computeExportSize chấp nhận đúng tại biên 16384 px', () => {
        const res = computeExportSize(MAX_EXPORT_PX / 4, 100, 4);
        expect(res.ok).toBe(true);
        expect(res.width).toBe(MAX_EXPORT_PX);
        expect(res.reason).toBeUndefined();
    });

    it('computeExportSize từ chối kích thước khung xem không hợp lệ', () => {
        expect(computeExportSize(0, 100, 1).ok).toBe(false);
        expect(computeExportSize(Number.NaN, 100, 1).ok).toBe(false);
        expect(computeExportSize(-10, 100, 2).ok).toBe(false);
    });

    it('store: exportScale mặc định 1 và đổi được sang 2/4 (nhánh chọn độ phân giải)', () => {
        expect(store().exportScale).toBe(1);
        store().setExportScale(2);
        expect(store().exportScale).toBe(2);
        store().setExportScale(4);
        expect(store().exportScale).toBe(4);
    });

    it('store: nonce yêu cầu xuất PNG/GLB tăng đơn điệu (cầu nối ra Canvas)', () => {
        const png0 = store().exportPngNonce;
        const glb0 = store().exportGlbNonce;
        store().requestExportPng();
        store().requestExportGlb();
        expect(store().exportPngNonce).toBe(png0 + 1);
        expect(store().exportGlbNonce).toBe(glb0 + 1);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Trạng thái phụ trợ — explodedFactor clamp (nhánh giá trị ngoài miền)
// ──────────────────────────────────────────────────────────────────────────

describe('Trạng thái store — clamp giá trị ngoài miền', () => {
    it('explodedFactor được clamp về [0, 5]', () => {
        store().setExplodedFactor(99);
        expect(store().explodedFactor).toBe(5);
        store().setExplodedFactor(-3);
        expect(store().explodedFactor).toBe(0);
        store().setExplodedFactor(Number.NaN);
        expect(store().explodedFactor).toBe(0);
        store().setExplodedFactor(2.5);
        expect(store().explodedFactor).toBe(2.5);
    });

    it('embossHeightMm được clamp về [0, 5]', () => {
        store().setEmbossHeightMm(10);
        expect(store().artwork.embossHeightMm).toBe(5);
        store().setEmbossHeightMm(-1);
        expect(store().artwork.embossHeightMm).toBe(0);
    });

    it('resetMockup khôi phục toàn bộ state về mặc định', () => {
        store().setBackgroundPreset('studio-dark');
        store().setHdriStatus('failed');
        store().setExportScale(4);
        store().setWebglSupported(false);
        store().resetMockup();
        expect(store().hdriStatus).toBe('loading');
        expect(store().exportScale).toBe(1);
        expect(store().webglSupported).toBe(true);
    });
});
