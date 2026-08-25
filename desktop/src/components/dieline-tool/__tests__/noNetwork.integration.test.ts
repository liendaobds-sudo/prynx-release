// @vitest-environment jsdom
// ============================================================
// noNetwork.integration.test.ts — Mockup 3D Realism (Integration)
//
// Integration test chứng minh ràng buộc PHÍA CLIENT của khung xem 3D:
// trong khi vận hành lớp logic/state của mockup (useMockupStore +
// lib/mockup3d + định nghĩa môi trường thủ tục của EnvironmentRig),
// hệ thống KHÔNG phát sinh BẤT KỲ request mạng nào — 0 backend request,
// 0 telemetry request.
//
// Cách kiểm chứng: spy toàn bộ các "network primitive" của trình duyệt
//   - global `fetch`
//   - `XMLHttpRequest.prototype.open` / `.send`
//   - constructor `WebSocket`
// sau đó thực thi (exercise) toàn bộ đường dẫn logic/state có thể chạy
// mà không cần render WebGL, và khẳng định KHÔNG spy nào bị gọi.
//
// Test giữ ở mức nhẹ (jsdom) — KHÔNG mount <Canvas>/không cần GPU. Định
// nghĩa môi trường thủ tục của EnvironmentRig được kiểm ở mức dữ liệu
// (mọi preset đều dựng cục bộ, không tham chiếu tệp HDRI từ mạng).
//
// Validates: Requirements 9.5
// Feature: mockup-3d-realism
// @vitest-environment jsdom
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { useMockupStore } from '../../../stores/useMockupStore';
import {
    buildPanelSolid,
    clampThickness,
    normalizeEdgeColor,
    applyFinishToAllPanels,
    getFinish,
    FINISH_LIBRARY,
    mapSpotUvRoughness,
    clampEmbossHeight,
    validateMask,
    clampArtworkTransform,
    computePanelUV,
    computeExplodedOffset,
    applyExplodedOffset,
    clampExplodeFactor,
    formatDimensions,
    computeExportSize,
    computeFoldThicknessOffset,
    applyFoldCompensation,
} from '../../../lib/mockup3d';
import type { BBox, FinishId } from '../../../lib/mockup3d';
import type { Panel } from '../../../lib/dieline/types';
// Định nghĩa môi trường studio "thủ tục" (procedural) của EnvironmentRig —
// import từ chính component render layer để kiểm tính KHÔNG-mạng của nó.
import { HDRI_PRESETS, getHdriPreset } from '../environmentPresets';

// ─── Spy network primitives ─────────────────────────────────────────────────

let fetchSpy: ReturnType<typeof vi.fn>;
let wsSpy: Mock<(...args: unknown[]) => void>;
let xhrOpenSpy: ReturnType<typeof vi.spyOn> | null;
let xhrSendSpy: ReturnType<typeof vi.spyOn> | null;
let imageSrcSpy: Mock<(value: string) => void> | null;

let originalFetch: typeof globalThis.fetch | undefined;
let originalWebSocket: typeof globalThis.WebSocket | undefined;

beforeEach(() => {
    // fetch — thay bằng fn ghi nhận; lưu bản gốc để khôi phục.
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn(() => Promise.reject(new Error('network call not allowed in test')));
    // @ts-expect-error gán mock cho global fetch trong môi trường test
    globalThis.fetch = fetchSpy;

    // WebSocket — thay constructor bằng lớp ghi nhận lần khởi tạo.
    originalWebSocket = globalThis.WebSocket;
    wsSpy = vi.fn<(...args: unknown[]) => void>();
    class MockWebSocket {
        constructor(...args: unknown[]) {
            wsSpy(...args);
        }
    }
    // @ts-expect-error gán mock cho global WebSocket trong môi trường test
    globalThis.WebSocket = MockWebSocket;

    // XMLHttpRequest — spy open/send trên prototype (jsdom cung cấp XHR).
    if (typeof XMLHttpRequest !== 'undefined') {
        xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
        xhrSendSpy = vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {
            /* chặn gửi thật, chỉ ghi nhận lời gọi */
        });
    } else {
        xhrOpenSpy = null;
        xhrSendSpy = null;
    }

    // Image.src — nạp ảnh qua thẻ <img> cũng là một dạng request mạng.
    // Theo dõi việc gán `src` để bắt mọi tải tài nguyên ngầm.
    if (typeof Image !== 'undefined') {
        const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        imageSrcSpy = vi.fn<(value: string) => void>();
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
            configurable: true,
            set(value: string) {
                imageSrcSpy?.(value);
            },
            get() {
                return '';
            },
        });
        // Lưu lại descriptor gốc để khôi phục.
        (HTMLImageElement.prototype as unknown as { __origSrcDesc?: PropertyDescriptor }).__origSrcDesc =
            desc;
    } else {
        imageSrcSpy = null;
    }
});

afterEach(() => {
    // Khôi phục global gốc + spy.
    if (originalFetch === undefined) {
        // @ts-expect-error xóa fetch nếu trước đó không tồn tại
        delete globalThis.fetch;
    } else {
        globalThis.fetch = originalFetch;
    }
    if (originalWebSocket === undefined) {
        // @ts-expect-error xóa WebSocket nếu trước đó không tồn tại
        delete globalThis.WebSocket;
    } else {
        globalThis.WebSocket = originalWebSocket;
    }
    xhrOpenSpy?.mockRestore();
    xhrSendSpy?.mockRestore();

    if (imageSrcSpy) {
        const proto = HTMLImageElement.prototype as unknown as {
            __origSrcDesc?: PropertyDescriptor;
        };
        if (proto.__origSrcDesc) {
            Object.defineProperty(HTMLImageElement.prototype, 'src', proto.__origSrcDesc);
            delete proto.__origSrcDesc;
        }
    }

    useMockupStore.getState().resetMockup();
    vi.restoreAllMocks();
});

/** Khẳng định KHÔNG network primitive nào bị gọi. */
function expectZeroNetworkActivity(): void {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(wsSpy).not.toHaveBeenCalled();
    if (xhrOpenSpy) expect(xhrOpenSpy).not.toHaveBeenCalled();
    if (xhrSendSpy) expect(xhrSendSpy).not.toHaveBeenCalled();
    if (imageSrcSpy) expect(imageSrcSpy).not.toHaveBeenCalled();
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Panel gốc hình chữ nhật 100×60 mm, không gập. */
const rootPanel: Panel = {
    name: 'front',
    label: 'Mặt trước',
    paths: [],
    outline: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 60 },
        { x: 0, y: 60 },
    ],
    holes: [],
    parent: null,
    pivotEdge: null,
    foldAngle: 0,
    foldDirection: 1,
};

/** Panel con có quan hệ gập hợp lệ (pivotEdge + parent). */
const childPanel: Panel = {
    name: 'left',
    label: 'Hông trái',
    paths: [],
    outline: [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 60 },
        { x: 0, y: 60 },
    ],
    holes: [],
    parent: 'front',
    pivotEdge: [
        { x: 0, y: 0 },
        { x: 0, y: 60 },
    ],
    foldAngle: 90,
    foldDirection: 1,
};

/** Panel thiếu hình học (có quan hệ gập nhưng thiếu pivotEdge) → bị skip. */
const brokenPanel: Panel = {
    name: 'broken',
    label: 'Lỗi',
    paths: [],
    outline: rootPanel.outline,
    holes: [],
    parent: 'front',
    pivotEdge: null,
    foldAngle: 90,
    foldDirection: 1,
};

const ALL_PANELS: Panel[] = [rootPanel, childPanel, brokenPanel];
const GLOBAL_BBOX: BBox = { minX: 0, minY: 0, maxX: 140, maxY: 60, width: 140, height: 60 };
const FINISH_IDS: FinishId[] = Object.keys(FINISH_LIBRARY) as FinishId[];

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Mockup 3D — 0 backend/telemetry request (Yêu cầu 9.5)', () => {
    it('thiết lập spy đúng: các network primitive sẵn sàng theo dõi', () => {
        // Sanity: bảo đảm spy thực sự hoạt động (nếu gọi thì bắt được).
        expect(fetchSpy).toBeDefined();
        expect(wsSpy).toBeDefined();
        expect(typeof XMLHttpRequest).toBe('function');
        expectZeroNetworkActivity();
    });

    it('vận hành useMockupStore actions KHÔNG phát sinh request mạng', () => {
        const s = useMockupStore.getState();

        s.setEdgeColor('white');
        s.setFinishId('gloss-lam');
        s.setHdriPreset('studio-contrast');
        s.setCameraPreset('isometric');
        s.setBackgroundPreset('studio-white');
        s.setExplodedFactor(2.5);
        s.setShowDimensions(true);
        s.setExportScale(4);
        s.setHdriStatus('ready');
        s.setWebglSupported(true);

        // Ảnh nghệ thuật mặt ngoài / mặt trong (URL object cục bộ giả lập).
        s.setOuterArtworkUrl('blob:mock-outer');
        s.setOuterArtworkTransform({ scalePct: 250, offsetXPct: 30, offsetYPct: -40 });
        s.setInnerArtworkEnabled(true);
        s.setInnerArtworkUrl('blob:mock-inner');
        s.setInnerArtworkTransform({ scalePct: 50, offsetXPct: -10, offsetYPct: 10 });
        s.setArtworkMode('aligned-to-dieline');
        s.setShowBleedSafe(true);
        s.setSpotUvMaskUrl('blob:mock-spotuv');
        s.setEmbossMaskUrl('blob:mock-emboss');
        s.setEmbossHeightMm(3.2);

        // Cầu nối xuất cảnh: chỉ tăng nonce, không tự gọi mạng.
        s.requestExportPng();
        s.requestExportGlb();

        // Xác nhận state đã cập nhật (logic chạy thật, không no-op).
        const next = useMockupStore.getState();
        expect(next.edgeColor).toBe('white');
        expect(next.finishId).toBe('gloss-lam');
        expect(next.artwork.mode).toBe('aligned-to-dieline');
        expect(next.exportPngNonce).toBe(1);
        expect(next.exportGlbNonce).toBe(1);

        expectZeroNetworkActivity();
    });

    it('vận hành hình học panel solid + chuẩn hóa KHÔNG phát sinh request mạng', () => {
        for (const t of [undefined, -1, 0, 0.5, 12, 80, NaN]) {
            expect(clampThickness(t as number)).toBeGreaterThan(0);
        }
        expect(normalizeEdgeColor('white')).toBe('white');
        expect(normalizeEdgeColor('rainbow')).toBe('kraft');

        // buildPanelSolid dựng ExtrudeGeometry trên CPU (không cần GPU/mạng).
        const geo = buildPanelSolid(rootPanel, 2);
        expect(geo.getAttribute('position').count).toBeGreaterThan(0);
        geo.dispose();

        const childGeo = buildPanelSolid(childPanel, clampThickness(0.5));
        expect(childGeo.getAttribute('position').count).toBeGreaterThan(0);
        childGeo.dispose();

        expectZeroNetworkActivity();
    });

    it('vận hành thư viện vật liệu/finish + mask KHÔNG phát sinh request mạng', () => {
        for (const id of FINISH_IDS) {
            const spec = getFinish(id);
            expect(spec.roughness).toBeGreaterThanOrEqual(0);
            expect(spec.metalness).toBeLessThanOrEqual(1);
        }
        const specs = applyFinishToAllPanels(ALL_PANELS, 'spot-uv');
        expect(specs).toHaveLength(ALL_PANELS.length);
        expect(specs.every((sp) => sp.id === 'spot-uv')).toBe(true);

        expect(mapSpotUvRoughness(0.8, 0.7)).toBeLessThan(0.7); // vùng mask >50% → bóng
        expect(mapSpotUvRoughness(0.3, 0.7)).toBe(0.7); // ngoài mask → giữ nền
        expect(clampEmbossHeight(99)).toBe(5);

        const okMask = validateMask({ width: 512, height: 512, format: 'image/png' }, { width: 512, height: 512 });
        expect(okMask.valid).toBe(true);
        const badMask = validateMask({ width: 10, height: 10, format: 'gif' }, { width: 512, height: 512 });
        expect(badMask.valid).toBe(false);

        expectZeroNetworkActivity();
    });

    it('vận hành ánh xạ ảnh nghệ thuật (UV + clamp) KHÔNG phát sinh request mạng', () => {
        const clamped = clampArtworkTransform({ scalePct: 9999, offsetXPct: -999, offsetYPct: 999 });
        expect(clamped.scalePct).toBe(1000);
        expect(clamped.offsetXPct).toBe(-100);
        expect(clamped.offsetYPct).toBe(100);

        const uvOuter = computePanelUV(childPanel, 'per-face', clamped, GLOBAL_BBOX, 'outer');
        const uvInner = computePanelUV(childPanel, 'aligned-to-dieline', clamped, GLOBAL_BBOX, 'inner');
        expect(uvOuter.length).toBe(childPanel.outline!.length * 2);
        expect(uvInner.length).toBe(childPanel.outline!.length * 2);

        expectZeroNetworkActivity();
    });

    it('vận hành exploded view + overlay + export sizing KHÔNG phát sinh request mạng', () => {
        expect(clampExplodeFactor(99)).toBe(5);
        const offset = computeExplodedOffset({ x: 1, y: 0, z: 0 }, 2, 10);
        expect(offset.x).toBeCloseTo(20);
        const pos = applyExplodedOffset({ x: 5, y: 5, z: 5 }, { x: 0, y: 0, z: 1 }, 0, 10);
        expect(pos).toEqual({ x: 5, y: 5, z: 5 }); // factor 0 → round-trip

        const dims = formatDimensions({ length: 120.04, width: 60.16, height: 200.0 });
        expect(dims.label).toContain('mm');

        expect(computeExportSize(1920, 1080, 4).ok).toBe(true);
        expect(computeExportSize(8000, 4000, 4).ok).toBe(false); // vượt 16384

        expectZeroNetworkActivity();
    });

    it('vận hành bù độ dày khi gập KHÔNG phát sinh request mạng', () => {
        const depthMap = new Map<string, number>([
            ['front', 0],
            ['left', 1],
            ['broken', 1],
        ]);

        expect(computeFoldThicknessOffset({ depth: 1, thickness: 0.5, foldAngleDeg: 90 })).toBeGreaterThan(0);

        const okResult = applyFoldCompensation(childPanel, ALL_PANELS, 1, depthMap, 1, 0.5);
        expect(okResult.skipped).toBe(false);
        expect(okResult.matrix).toBeDefined();

        const skipResult = applyFoldCompensation(brokenPanel, ALL_PANELS, 1, depthMap, 1, 0.5);
        expect(skipResult.skipped).toBe(true);
        expect(skipResult.warning).toContain('broken');

        expectZeroNetworkActivity();
    });

    it('môi trường studio của EnvironmentRig là THỦ TỤC (procedural), không tải HDRI từ mạng', () => {
        // Mọi preset HDRI phải dựng cục bộ: KHÔNG preset nào tham chiếu
        // tệp HDRI tải qua mạng (trường `file` để trống). Đây là cốt lõi
        // của ràng buộc 0-request của EnvironmentRig (Yêu cầu 9.5).
        expect(HDRI_PRESETS.length).toBeGreaterThanOrEqual(3);
        for (const preset of HDRI_PRESETS) {
            expect(preset.file).toBeUndefined();
            expect(preset.lightformers.length).toBeGreaterThan(0);
            // Lấy preset qua API tra cứu (đường dẫn dùng thực tế trong Rig).
            expect(getHdriPreset(preset.id).id).toBe(preset.id);
        }
        // id không hợp lệ → fallback preset đầu, vẫn không có `file` mạng.
        expect(getHdriPreset('khong-ton-tai').file).toBeUndefined();

        expectZeroNetworkActivity();
    });
});
