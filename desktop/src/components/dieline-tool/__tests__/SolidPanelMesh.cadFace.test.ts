import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { bufferToCadFaceSegPoints } from '../cadFace';

describe('SolidPanelMesh CAD face', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([
            1, 2, 0,
            3, 4, 0,
        ], 3),
    );

    it('đặt nét CAD lên cap +Z khi mặt ngoài giữ hướng mặc định', () => {
        expect(bufferToCadFaceSegPoints(geometry, 0.3, false)).toEqual([
            [1, 2, 0.3],
            [3, 4, 0.3],
        ]);
    });

    it('đặt nét CAD lên cap −Z khi mặt ngoài bị đảo', () => {
        expect(bufferToCadFaceSegPoints(geometry, 0.3, true)).toEqual([
            [1, 2, -0.3],
            [3, 4, -0.3],
        ]);
    });
});
