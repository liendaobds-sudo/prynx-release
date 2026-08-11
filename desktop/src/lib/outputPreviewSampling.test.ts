import { describe, expect, it } from 'vitest';

import {
    normalizePageHoverPosition,
    sampleOutputPreviewInk,
} from './outputPreviewSampling';

describe('Output Preview — lấy mẫu mực theo đơn vị thật', () => {
    it('lấy đúng một pixel khi chọn chế độ Điểm', () => {
        const sample = sampleOutputPreviewInk({
            arrays: {
                Cyan: new Uint8ClampedArray([0, 64, 128, 255]),
                Black: new Uint8ClampedArray([0, 0, 255, 255]),
            },
            width: 2,
            height: 2,
            xRatio: 1,
            yRatio: 1,
            renderDpi: 150,
            sampleDiameterMm: 0,
        });

        expect(sample.sampledPixels).toBe(1);
        expect(sample.channelPercentages).toEqual({ Cyan: 100, Black: 100 });
        expect(sample.totalPercent).toBe(200);
    });

    it('trung bình vùng tròn theo mm và DPI artifact', () => {
        const arrays = { Cyan: new Uint8ClampedArray(41 * 41).fill(128) };
        const lowDpi = sampleOutputPreviewInk({
            arrays,
            width: 41,
            height: 41,
            xRatio: 0.5,
            yRatio: 0.5,
            renderDpi: 72,
            sampleDiameterMm: 3,
        });
        const highDpi = sampleOutputPreviewInk({
            arrays,
            width: 41,
            height: 41,
            xRatio: 0.5,
            yRatio: 0.5,
            renderDpi: 150,
            sampleDiameterMm: 3,
        });

        expect(lowDpi.channelPercentages.Cyan).toBe(50);
        expect(highDpi.channelPercentages.Cyan).toBe(50);
        expect(highDpi.sampledPixels).toBeGreaterThan(lowDpi.sampledPixels);
        expect(highDpi.diameterPx).toBeCloseTo(3 * 150 / 25.4, 6);
    });

    it('kẹp vùng lấy mẫu tại mép trang', () => {
        const sample = sampleOutputPreviewInk({
            arrays: { Black: new Uint8ClampedArray(25).fill(255) },
            width: 5,
            height: 5,
            xRatio: -1,
            yRatio: -1,
            renderDpi: 150,
            sampleDiameterMm: 1,
        });
        expect(sample.sampledPixels).toBeGreaterThan(1);
        expect(sample.sampledPixels).toBeLessThan(25);
        expect(sample.totalPercent).toBe(100);
    });

    it('vùng bị Show filter ẩn có mọi kênh bằng 0 và TAC bằng 0', () => {
        // Synthetic hai nửa: nửa trái DeviceCMYK đã bị Show=DeviceRGB lọc
        // khỏi chính plate backend; nửa phải còn một vùng Cyan để chốt chiều dữ liệu.
        const arrays = {
            Cyan: new Uint8ClampedArray([0, 255]),
            Magenta: new Uint8ClampedArray([0, 0]),
            Yellow: new Uint8ClampedArray([0, 0]),
            Black: new Uint8ClampedArray([0, 0]),
        };
        const hidden = sampleOutputPreviewInk({
            arrays,
            width: 2,
            height: 1,
            xRatio: 0,
            yRatio: 0,
            renderDpi: 150,
            sampleDiameterMm: 0,
        });
        const visible = sampleOutputPreviewInk({
            arrays,
            width: 2,
            height: 1,
            xRatio: 1,
            yRatio: 0,
            renderDpi: 150,
            sampleDiameterMm: 0,
        });

        expect(hidden.channelPercentages).toEqual({
            Cyan: 0,
            Magenta: 0,
            Yellow: 0,
            Black: 0,
        });
        expect(hidden.totalPercent).toBe(0);
        expect(visible.channelPercentages.Cyan).toBe(100);
    });

    it('fail-loud khi backend không khai DPI artifact', () => {
        expect(() => sampleOutputPreviewInk({
            arrays: { Cyan: new Uint8ClampedArray([0]) },
            width: 1,
            height: 1,
            xRatio: 0,
            yRatio: 0,
            renderDpi: 0,
            sampleDiameterMm: 1,
        })).toThrow(/DPI artifact/);
    });

    it('chuẩn hóa theo kích thước trang chưa xoay, không theo AABB xoay', () => {
        expect(normalizePageHoverPosition(150, 50, 300, 100)).toEqual({ x: 0.5, y: 0.5 });
        expect(normalizePageHoverPosition(999, -10, 300, 100)).toEqual({ x: 1, y: 0 });
    });
});
