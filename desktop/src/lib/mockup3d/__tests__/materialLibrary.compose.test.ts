import { describe, it, expect } from 'vitest';
import {
    composeAppearance,
    migrateLegacyFinishId,
    substrateInnerFaceColor,
    substrateDefaultEdgeColor,
    SUBSTRATE_LIBRARY,
    SURFACE_FINISH_LIBRARY,
} from '../materialLibrary';

describe('composeAppearance — substrate × surface', () => {
    it('kraft + none = giấy kraft trần', () => {
        const a = composeAppearance('kraft', 'none');
        expect(a.substrateId).toBe('kraft');
        expect(a.surfaceFinishId).toBe('none');
        expect(a.baseColor).toBe(SUBSTRATE_LIBRARY.kraft.baseColor);
        expect(a.needsSpotUvMask).toBe(false);
        expect(a.phys.grainBumpScale).toBeGreaterThan(0);
    });

    it('sbs + gloss-lam: giữ hue giấy, clearcoat cao', () => {
        const a = composeAppearance('sbs-white', 'gloss-lam');
        expect(a.baseColor).toBe(SUBSTRATE_LIBRARY['sbs-white'].baseColor);
        expect(a.phys.clearcoat).toBeGreaterThan(0.5);
        expect(a.phys.grainBumpScale).toBe(0);
        expect(a.label).toContain('SBS');
        expect(a.label).toContain('bóng');
    });

    it('kraft + foil: override albedo metallic', () => {
        const a = composeAppearance('kraft', 'foil-metallic');
        expect(a.baseColor).toBe(SURFACE_FINISH_LIBRARY['foil-metallic'].overrideBaseColor);
        expect(a.phys.metalness).toBeGreaterThan(0.5);
    });

    it('spot-uv / emboss set mask flags', () => {
        expect(composeAppearance('kraft', 'spot-uv').needsSpotUvMask).toBe(true);
        expect(composeAppearance('kraft', 'emboss').needsEmbossMask).toBe(true);
    });

    it('migrate legacy finishId', () => {
        expect(migrateLegacyFinishId('kraft')).toEqual({
            substrateId: 'kraft',
            surfaceFinishId: 'none',
        });
        expect(migrateLegacyFinishId('gloss-lam')).toEqual({
            substrateId: 'kraft',
            surfaceFinishId: 'gloss-lam',
        });
        expect(migrateLegacyFinishId('sbs-white')).toEqual({
            substrateId: 'sbs-white',
            surfaceFinishId: 'none',
        });
    });

    it('mặt trong theo substrate: SBS trắng ngà, kraft nâu', () => {
        const kraftInner = substrateInnerFaceColor('kraft');
        const sbsInner = substrateInnerFaceColor('sbs-white');
        expect(sbsInner).not.toBe(kraftInner);
        // SBS không được nâu kraft
        expect(sbsInner.toLowerCase()).not.toBe('#a9784a');
        expect(substrateDefaultEdgeColor('sbs-white')).toBe('white');
        expect(substrateDefaultEdgeColor('kraft')).toBe('kraft');
    });
});
