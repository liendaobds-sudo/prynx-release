import { describe, expect, it } from 'vitest';

import {
    applyStickerMaskEdits,
    decodeLabelRgb,
    renderStickerMaskOverlay,
} from './stickerMaskProtocol';


describe('stickerMaskProtocol — chỉnh mask ngoài React', () => {
    it('giải mã id instance 24-bit từ label-map RGB', () => {
        const rgba = new Uint8ClampedArray([
            1, 0, 0, 255,
            2, 1, 0, 255,
        ]);
        expect([...decodeLabelRgb(rgba)]).toEqual([1, 258]);
    });

    it('xóa, giữ lại và gộp instance theo đúng thứ tự edit', () => {
        const original = new Uint32Array(100).fill(0);
        original[22] = 1;
        original[77] = 2;
        const labels = applyStickerMaskEdits(original, 10, 10, [
            {
                kind: 'stroke', id: 'erase', tool: 'erase', instanceId: 1,
                radius: 0.11, points: [{ x: 0.25, y: 0.25 }],
            },
            {
                kind: 'stroke', id: 'restore', tool: 'restore', instanceId: 2,
                radius: 0.06, points: [{ x: 0.5, y: 0.5 }],
            },
            { kind: 'merge', id: 'merge', sourceId: 2, targetId: 1 },
        ]);
        expect(labels[22]).toBe(0);
        expect(labels[55]).toBe(1);
        expect(labels[77]).toBe(1);
    });

    it('render overlay chỉ vẽ biên, không phủ màu lên lòng tem', () => {
        const labels = new Uint32Array([
            0, 0, 0, 0, 0,
            0, 1, 1, 1, 0,
            0, 1, 1, 1, 0,
            0, 1, 1, 2, 0,
            0, 0, 0, 0, 0,
        ]);
        const uncertainty = new Uint8Array(labels.length);
        uncertainty[8] = 255;
        const overlay = renderStickerMaskOverlay(labels, uncertainty, 5, 5, 1);
        expect(overlay[3]).toBe(0);
        expect(overlay[(2 * 5 + 2) * 4 + 3]).toBe(0);
        expect(overlay[(1 * 5 + 1) * 4 + 3]).toBeGreaterThan(0);
        expect(overlay[8 * 4]).toBe(255);
        expect(overlay[8 * 4 + 1]).toBe(150);
    });
});
