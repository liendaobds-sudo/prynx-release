import { describe, expect, it } from 'vitest';
import {
    patchSpotUvRoughnessShader,
    patchSpotUvClearcoatShader,
    patchSpotUvPhysicalShader,
} from '../surfaceFinishShader';

describe('Spot-UV material shader', () => {
    it('vùng mask trắng chuyển sang roughness bóng và nền được giữ nguyên', () => {
        const source = 'before\nroughnessFactor *= texelRoughness.g;\nafter';
        const patched = patchSpotUvRoughnessShader(source);

        expect(patched).toContain('texelRoughness.g > 0.5');
        expect(patched).toContain('? 0.0800 : roughnessFactor');
        expect(patched).not.toContain('roughnessFactor *= texelRoughness.g;');
    });

    it('vùng mask trắng chuyển sang clearcoat bóng UV', () => {
        const source = 'clearcoatFactor *= texelClearcoat.x;\nrest';
        const patched = patchSpotUvClearcoatShader(source);
        expect(patched).toContain('texelClearcoat.x > 0.5');
        expect(patched).toContain('0.9000');
        expect(patched).not.toContain('clearcoatFactor *= texelClearcoat.x;');
    });

    it('patch Physical kết hợp roughness + clearcoat', () => {
        const source = [
            'roughnessFactor *= texelRoughness.g;',
            'clearcoatFactor *= texelClearcoat.x;',
            'clearcoatRoughnessFactor *= texelClearcoatRoughness.y;',
        ].join('\n');
        const patched = patchSpotUvPhysicalShader(source);
        expect(patched).toContain('roughnessFactor = texelRoughness.g > 0.5');
        expect(patched).toContain('clearcoatFactor = texelClearcoat.x > 0.5');
        expect(patched).toContain('clearcoatRoughnessFactor = texelClearcoatRoughness.y > 0.5');
    });

    it('không phá shader nếu Three thay đổi chunk mục tiêu', () => {
        const source = 'void main() {}';
        expect(patchSpotUvRoughnessShader(source)).toBe(source);
        expect(patchSpotUvClearcoatShader(source)).toBe(source);
        expect(patchSpotUvPhysicalShader(source)).toBe(source);
    });
});
