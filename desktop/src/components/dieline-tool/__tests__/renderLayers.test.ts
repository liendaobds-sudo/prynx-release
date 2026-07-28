import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
    MOCKUP_VISUAL_ONLY_LAYER,
    moveToMockupVisualOnlyLayer,
} from '../renderLayers';

describe('renderLayers', () => {
    it('tách toàn bộ cây đường CAD khỏi layer chụp bóng mặc định', () => {
        const root = new THREE.Group();
        const nested = new THREE.Group();
        const cadLine = new THREE.Line();
        nested.add(cadLine);
        root.add(nested);

        moveToMockupVisualOnlyLayer(root);

        const mainCamera = new THREE.PerspectiveCamera();
        mainCamera.layers.enable(MOCKUP_VISUAL_ONLY_LAYER);
        const shadowCamera = new THREE.OrthographicCamera();

        expect(root.layers.test(mainCamera.layers)).toBe(true);
        expect(nested.layers.test(mainCamera.layers)).toBe(true);
        expect(cadLine.layers.test(mainCamera.layers)).toBe(true);
        expect(root.layers.test(shadowCamera.layers)).toBe(false);
        expect(nested.layers.test(shadowCamera.layers)).toBe(false);
        expect(cadLine.layers.test(shadowCamera.layers)).toBe(false);
    });
});