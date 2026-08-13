import { describe, expect, it } from 'vitest';
import {
    resolveEffectiveImpositionAlign,
    resolveEffectiveSeparateCut,
    resolveImpositionModes,
    resolveImpositionSplitGap,
} from './pageSheetPolicy';

describe('pageSheetPolicy', () => {
    it('isolates whole-sheet routing to the sticker tool', () => {
        expect(resolveImpositionModes('sticker_imposer', 'page_sheet')).toEqual({
            pageSheetMode: true,
            stickerGeometryMode: false,
            dieGeometryMode: false,
            pontSettingsMode: true,
            stickerToolIdentity: true,
        });
        expect(resolveImpositionModes('cnc_imposer', 'page_sheet')).toMatchObject({
            pageSheetMode: false,
            dieGeometryMode: true,
            pontSettingsMode: true,
        });
        expect(resolveImpositionModes('nup', 'page_sheet')).toMatchObject({
            pageSheetMode: false,
            dieGeometryMode: false,
            pontSettingsMode: false,
        });
    });

    it('forces paired print/cut pages for whole-sheet output consumers', () => {
        expect(resolveEffectiveSeparateCut('sticker_imposer', 'page_sheet', false)).toBe(true);
        expect(resolveEffectiveSeparateCut('sticker_imposer', 'sticker', false)).toBe(false);
        expect(resolveEffectiveSeparateCut('nup', 'page_sheet', false)).toBe(false);
        expect(resolveEffectiveSeparateCut('sticker_imposer', 'sticker', true)).toBe(true);
    });

    it('uses one split-gap rule for die and guillotine geometry', () => {
        expect(resolveImpositionSplitGap({
            dieGeometryMode: true,
            gapX: 2,
            gapY: 3,
            clusterGap: 10,
            markType: 'guillotine',
        })).toBe(3);
        expect(resolveImpositionSplitGap({
            dieGeometryMode: false,
            gapX: 0,
            gapY: 0,
            clusterGap: 0,
            clusterGapMode: 'mark',
            markType: 'guillotine',
            markLength: 5,
            markOffset: 3,
        })).toBe(16);
        expect(resolveImpositionSplitGap({
            dieGeometryMode: false,
            gapX: 2,
            gapY: 3,
            clusterGap: 12,
            clusterGapMode: 'item',
            markType: 'guillotine',
            markLength: 5,
            markOffset: 3,
        })).toBe(12);
    });

    it('centers a whole decal sheet instead of inheriting a hidden guillotine alignment', () => {
        expect(resolveEffectiveImpositionAlign(true, 'top-center')).toBe('center');
        expect(resolveEffectiveImpositionAlign(true, 'bottom-right')).toBe('center');
        expect(resolveEffectiveImpositionAlign(false, 'top-center')).toBe('top-center');
        expect(resolveEffectiveImpositionAlign(false, undefined)).toBe('center');
    });

    it('uses the item gap for the L-shape secondary block when cut marks are disabled', () => {
        expect(resolveImpositionSplitGap({
            dieGeometryMode: false,
            gapX: 0,
            gapY: 0,
            clusterGap: 0,
            markType: 'none',
        })).toBe(0);
        expect(resolveImpositionSplitGap({
            dieGeometryMode: false,
            gapX: 2,
            gapY: 3,
            clusterGap: 12,
            clusterGapMode: 'item',
            markType: 'none',
        })).toBe(3);
        expect(resolveImpositionSplitGap({
            dieGeometryMode: false,
            gapX: 0,
            gapY: 0,
            clusterGap: 12,
            clusterGapMode: 'item',
            markType: 'none',
        })).toBe(0);
    });
});
