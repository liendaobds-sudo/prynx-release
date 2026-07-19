import { describe, expect, it } from 'vitest';
import { computePanelUV } from '../artworkMapping';
import type { ArtworkTransform, BBox, Panel, Point2D } from '../types';

const IDENTITY: ArtworkTransform = {
    scalePct: 100,
    offsetXPct: 0,
    offsetYPct: 0,
    rotationDeg: 0,
};

function rectangle(width: number, height: number): { panel: Panel; bbox: BBox } {
    const outline: Point2D[] = [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
    ];
    return {
        panel: {
            name: 'face',
            label: 'Mặt',
            paths: [],
            outline,
            parent: null,
            pivotEdge: null,
            foldAngle: 0,
            foldDirection: 1,
        },
        bbox: { minX: 0, minY: 0, maxX: width, maxY: height, width, height },
    };
}

describe('computePanelUV — giữ nguyên tỷ lệ ảnh nguồn', () => {
    it('ảnh vuông phủ khung ngang bằng crop dọc, không kéo giãn', () => {
        const { panel, bbox } = rectangle(200, 100);
        const uv = computePanelUV(panel, 'aligned-to-dieline', IDENTITY, bbox, 'outer', 1);

        expect(Array.from(uv)).toEqual([
            0, 0.25,
            1, 0.25,
            1, 0.75,
            0, 0.75,
        ]);
        // Một chiều rộng ảnh và một chiều cao ảnh đều tương ứng 200 mm.
        const mmPerTextureU = bbox.width / (uv[2] - uv[0]);
        const mmPerTextureV = bbox.height / (uv[5] - uv[3]);
        expect(mmPerTextureU).toBeCloseTo(mmPerTextureV, 6);
    });

    it('ảnh ngang phủ khung dọc bằng crop ngang, không kéo giãn', () => {
        const { panel, bbox } = rectangle(100, 200);
        const uv = computePanelUV(panel, 'per-face', IDENTITY, bbox, 'outer', 2);

        expect(uv[0]).toBeCloseTo(0.375, 6);
        expect(uv[1]).toBeCloseTo(0, 6);
        expect(uv[4]).toBeCloseTo(0.625, 6);
        expect(uv[5]).toBeCloseTo(1, 6);
        const mmPerTextureU = bbox.width / (uv[2] - uv[0]);
        const mmPerTextureV = bbox.height / (uv[5] - uv[3]);
        // U của ảnh có tỷ lệ 2:1 nên một đơn vị U rộng gấp đôi một đơn vị V.
        expect(mmPerTextureU / mmPerTextureV).toBeCloseTo(2, 6);
    });

    it('scale 200% phóng đều cả hai trục', () => {
        const { panel, bbox } = rectangle(200, 100);
        const transform = { ...IDENTITY, scalePct: 200 };
        const uv = computePanelUV(panel, 'aligned-to-dieline', transform, bbox, 'outer', 1);

        expect(uv[2] - uv[0]).toBeCloseTo(0.5, 6);
        expect(uv[5] - uv[3]).toBeCloseTo(0.25, 6);
    });
});