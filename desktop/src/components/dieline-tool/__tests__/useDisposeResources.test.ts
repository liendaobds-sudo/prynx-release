import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { disposeMaterial, disposeResource } from '../useDisposeResources';

describe('quyền sở hữu tài nguyên GPU', () => {
    it('dispose material không hủy texture dùng chung', () => {
        const texture = new THREE.Texture();
        const material = new THREE.MeshStandardMaterial({ map: texture });
        const textureDispose = vi.spyOn(texture, 'dispose');
        const materialDispose = vi.spyOn(material, 'dispose');

        disposeMaterial(material);

        expect(materialDispose).toHaveBeenCalledOnce();
        expect(textureDispose).not.toHaveBeenCalled();
    });

    it('texture vẫn được hủy khi chủ sở hữu dispose trực tiếp', () => {
        const texture = new THREE.Texture();
        const textureDispose = vi.spyOn(texture, 'dispose');

        disposeResource(texture);

        expect(textureDispose).toHaveBeenCalledOnce();
    });
});