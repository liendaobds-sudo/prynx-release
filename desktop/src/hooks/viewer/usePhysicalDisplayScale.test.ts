import { describe, expect, it } from 'vitest';
import {
    calculatePhysicalDisplayScale,
    pdfPointsToPhysicalCssPixels,
    type NativeDisplayMetrics,
} from './usePhysicalDisplayScale';

const metrics = (rawDpiX: number | null, scaleFactor = 1): NativeDisplayMetrics => ({
    monitorId: 'test-monitor',
    monitorName: 'Test monitor',
    rawDpiX,
    rawDpiY: rawDpiX,
    scaleFactor,
    widthPx: 1920,
    heightPx: 1080,
});

describe('physical display scale', () => {
    it('giữ nguyên hệ px@96 trên màn 96 PPI ở DPR 1', () => {
        expect(calculatePhysicalDisplayScale(metrics(96), 1)).toBe(1);
    });

    it('hiển thị 15 cm đúng kích thước vật lý trên màn 92 PPI', () => {
        const rawDpi = 92;
        const scale = calculatePhysicalDisplayScale(metrics(rawDpi), 1);
        const widthPt = 150 / 25.4 * 72;
        const cssWidth = pdfPointsToPhysicalCssPixels(widthPt, scale);
        const measuredMm = cssWidth / rawDpi * 25.4;

        expect(scale).toBeCloseTo(92 / 96, 8);
        expect(cssWidth).toBeCloseTo(543.307, 3);
        expect(measuredMm).toBeCloseTo(150, 8);
    });

    it('không đếm DPR hai lần trên màn HiDPI', () => {
        const rawDpi = 110;
        const dpr = 1.5;
        const scale = calculatePhysicalDisplayScale(metrics(rawDpi, dpr), dpr);
        const widthPt = 150 / 25.4 * 72;
        const devicePixels = pdfPointsToPhysicalCssPixels(widthPt, scale) * dpr;
        const measuredMm = devicePixels / rawDpi * 25.4;

        expect(scale).toBeCloseTo(110 / (96 * 1.5), 8);
        expect(measuredMm).toBeCloseTo(150, 8);
    });

    it('fallback về tỷ lệ 1 khi hệ điều hành không trả raw DPI hợp lệ', () => {
        expect(calculatePhysicalDisplayScale(metrics(null), 1)).toBe(1);
        expect(calculatePhysicalDisplayScale(metrics(0), 1)).toBe(1);
    });
});
