// @vitest-environment jsdom
// PERF (audit độ nét 2026-07-28 §R.9): chốt bất biến của ngân sách pixel nền — cạnh dài
// bitmap không vượt ngân sách, và cài đặt "Chất lượng xem trước" thật sự có tác dụng
// (trước đợt này nó là nút chết, không đường render nào đọc).
import { describe, expect, it } from 'vitest';

import {
    computeRenderZoomPure,
    computeViewerBackgroundZoom,
    RENDER_BUDGET_PX,
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
        expect(VIEWPORT_TILE_SETTLE_MS).toBe(90);
        expect(VIEWPORT_TILE_SETTLE_MS).toBeLessThanOrEqual(100);
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
});
