// @vitest-environment jsdom
// PERF (audit độ nét 2026-07-28 §R.9): chốt bất biến của ngân sách pixel nền — cạnh dài
// bitmap không vượt ngân sách, và cài đặt "Chất lượng xem trước" thật sự có tác dụng
// (trước đợt này nó là nút chết, không đường render nào đọc).
import { describe, expect, it } from 'vitest';

import {
    ACCURATE_VIEWER_BASE_ZOOM_CAP,
    ACCURATE_VIEWER_BASE_ZOOM_MIN,
    computeAccurateViewerBaseZoom,
    computeRenderZoomPure,
    computeViewerBackgroundZoom,
    RENDER_BUDGET_PX,
    shouldPrefetchViewerPage,
    shouldUseViewerViewportTiles,
    VIEWPORT_TILE_SETTLE_MS,
} from './renderZoomPolicy';

// A4 dọc: 595×842 pt → px@96 (usePdfLoader dựng dims bằng widthPt × 96/72).
const A4_W = 595 * 96 / 72;   // ≈ 793.7
const A4_H = 842 * 96 / 72;   // ≈ 1122.7

/** Cạnh dài bitmap thực tế mà Rust sẽ tạo ở renderZoom này. */
const longEdgePx = (renderZoom: number) => Math.max(A4_W, A4_H) * renderZoom;

describe('computeRenderZoomPure — ngân sách pixel', () => {
    it('mặc định giữ nguyên trần 6000px (máy mạnh không bị hạ gì)', () => {
        const z = computeRenderZoomPure(8, A4_W, A4_W, A4_H);
        expect(longEdgePx(z)).toBeLessThanOrEqual(RENDER_BUDGET_PX.high + 1);
        expect(longEdgePx(z)).toBeGreaterThan(RENDER_BUDGET_PX.high - 50);
    });

    it("'fast' hạ ngân sách xuống 3000px → số pixel giảm ~4×", () => {
        const high = computeRenderZoomPure(8, A4_W, A4_W, A4_H, RENDER_BUDGET_PX.high);
        const fast = computeRenderZoomPure(8, A4_W, A4_W, A4_H, RENDER_BUDGET_PX.fast);
        expect(longEdgePx(fast)).toBeLessThanOrEqual(RENDER_BUDGET_PX.fast + 1);
        // Cạnh dài giảm 2× ⇒ diện tích (số pixel) giảm ~4×.
        expect(fast).toBeCloseTo(high / 2, 3);
    });

    it('zoom thấp KHÔNG bị ngân sách chặn — hai chế độ cho cùng kết quả', () => {
        const high = computeRenderZoomPure(2, A4_W, A4_W, A4_H, RENDER_BUDGET_PX.high);
        const fast = computeRenderZoomPure(2, A4_W, A4_W, A4_H, RENDER_BUDGET_PX.fast);
        expect(high).toBeCloseTo(2, 6);
        expect(fast).toBeCloseTo(2, 6);
    });

    it('không bao giờ xuống dưới devicePixelRatio (sàn chống mờ ở zoom nhỏ)', () => {
        const z = computeRenderZoomPure(0.25, A4_W, A4_W, A4_H);
        expect(z).toBeGreaterThanOrEqual(window.devicePixelRatio || 1);
    });

    it('map 100% vật lý 92 PPI thẳng 1:1 thay vì render 96 rồi co xuống', () => {
        const physicalScale = 92 / 96;
        const z = computeRenderZoomPure(
            physicalScale,
            A4_W,
            A4_W,
            A4_H,
            RENDER_BUDGET_PX.high,
            physicalScale,
        );
        expect(z).toBeCloseTo(physicalScale, 8);
        expect(A4_W * z).toBeCloseTo(A4_W * 92 / 96, 8);
    });

    it('giữ oversample chống mờ khi thu nhỏ sau hiệu chỉnh vật lý', () => {
        const physicalScale = 92 / 96;
        const z = computeRenderZoomPure(
            physicalScale * 0.5,
            A4_W,
            A4_W,
            A4_H,
            RENDER_BUDGET_PX.high,
            physicalScale,
        );
        expect(z).toBeCloseTo(physicalScale, 8);
    });

    it('trần cứng 24× vẫn còn hiệu lực với trang rất nhỏ', () => {
        // Trang 10×10pt: ngân sách cho phép hệ số khổng lồ, nhưng 24 phải chặn lại.
        const tiny = 10 * 96 / 72;
        expect(computeRenderZoomPure(100, tiny, tiny, tiny)).toBe(24);
    });

    it('trang NGANG cũng tôn trọng ngân sách theo cạnh dài', () => {
        // A4 ngang: w/h đảo lại; ratio = max(1, h/w) = 1 → cap = budget / w.
        const z = computeRenderZoomPure(8, A4_H, A4_H, A4_W, RENDER_BUDGET_PX.high);
        expect(A4_H * z).toBeLessThanOrEqual(RENDER_BUDGET_PX.high + 1);
    });
});

describe('Viewer — ưu tiên làm nét vùng đang nhìn', () => {
    it('bắt đầu tile sắc trong tối đa 100ms sau lần zoom cuối', () => {
        expect(VIEWPORT_TILE_SETTLE_MS).toBe(48);
        expect(VIEWPORT_TILE_SETTLE_MS).toBeLessThanOrEqual(50);
    });

    it('hạ nền active xuống 2×DPR khi tile viewport đảm nhiệm độ nét cuối', () => {
        expect(computeViewerBackgroundZoom(5.5, 1, true, true)).toBe(2);
        expect(computeViewerBackgroundZoom(9, 2, true, true)).toBe(4);
    });

    it('không hạ nền active khi chưa có tile sắc thay thế', () => {
        expect(computeViewerBackgroundZoom(5.5, 1, true, false)).toBe(5.5);
        expect(computeViewerBackgroundZoom(9, 2, true, false)).toBe(9);
    });

    it('giữ chính sách nền nhẹ hiện có cho trang không active', () => {
        expect(computeViewerBackgroundZoom(5.5, 1, false, false)).toBe(2);
        expect(computeViewerBackgroundZoom(3, 2, false, false)).toBe(3);
    });

    it('bật viewport tile zoom cao cho cả display và accurate', () => {
        expect(shouldUseViewerViewportTiles(true, true, false, 2, 4, 1, false)).toBe(true);
        expect(shouldUseViewerViewportTiles(true, true, false, 2, 4, 1, true)).toBe(true);
        expect(shouldUseViewerViewportTiles(true, false, false, 2, 4, 1, true)).toBe(false);
        expect(shouldUseViewerViewportTiles(true, true, true, 2, 4, 1, true)).toBe(false);
    });

    it('giữ accurate full-page ở mức xem thường và chỉ chuyển viewport khi zoom cao', () => {
        expect(shouldUseViewerViewportTiles(true, true, false, 1, 0.3, 1, true)).toBe(false);
        expect(shouldUseViewerViewportTiles(true, true, false, 1, 1, 1, true)).toBe(false);
        expect(shouldUseViewerViewportTiles(true, true, false, 2, 0.8, 2, true)).toBe(true);
        expect(shouldUseViewerViewportTiles(true, true, false, 2, 1.6, 1, true)).toBe(true);
    });

    it('mở trang bằng nền accurate tối thiểu 96 DPI để chữ đọc được ngay', () => {
        expect(ACCURATE_VIEWER_BASE_ZOOM_MIN).toBe(1);
        expect(ACCURATE_VIEWER_BASE_ZOOM_CAP).toBe(1.5);
        expect(computeAccurateViewerBaseZoom(1, 0.3, 1)).toBe(1);
        expect(computeAccurateViewerBaseZoom(1, 0.5, 1)).toBe(1);
        expect(computeAccurateViewerBaseZoom(2, 0.5, 2)).toBe(1.5);
        expect(computeAccurateViewerBaseZoom(6, 6, 1)).toBe(1.5);
    });

    it('chỉ dựng trước trang accurate sau khi trang active đã hiện', () => {
        expect(shouldPrefetchViewerPage(1, true, false)).toBe(false);
        expect(shouldPrefetchViewerPage(1, true, true)).toBe(true);
        expect(shouldPrefetchViewerPage(1, false, false)).toBe(true);
        expect(shouldPrefetchViewerPage(2, true, true)).toBe(false);
    });

    it('không đổi accurate viewport sang full-page nặng khi giảm qua ngưỡng tiling', () => {
        expect(shouldUseViewerViewportTiles(true, true, false, 6.0133, 6.33, 1, true)).toBe(true);
        expect(shouldUseViewerViewportTiles(true, true, false, 6.0133, 6.32, 1, true)).toBe(true);
        expect(shouldUseViewerViewportTiles(true, true, false, 6.0133, 6.32, 1, false)).toBe(false);
    });
});
