import { describe, expect, it } from 'vitest';
import { patchSpotUvRoughnessShader } from '../SolidPanelMesh';

describe('Spot-UV material shader', () => {
    it('vùng mask trắng chuyển sang roughness bóng và nền được giữ nguyên', () => {
        const source = 'before\nroughnessFactor *= texelRoughness.g;\nafter';
        const patched = patchSpotUvRoughnessShader(source);

        expect(patched).toContain('texelRoughness.g > 0.5');
        expect(patched).toContain('? 0.0800 : roughnessFactor');
        expect(patched).not.toContain('roughnessFactor *= texelRoughness.g;');
    });

    it('không phá shader nếu Three thay đổi chunk mục tiêu', () => {
        const source = 'void main() {}';
        expect(patchSpotUvRoughnessShader(source)).toBe(source);
    });
});