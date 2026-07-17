// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createImposerSettingsStore } from './useImposerSettingsStore';
import { applyRecommendation } from './applyRecommendation';
import { recommendInNhanh, type ProductInput } from '../../lib/imposerEngine/ProductAdvisor';

const input: ProductInput = {
    printMethod: 'in_nhanh', binding: 'saddle',
    finishedWidthMm: 74, finishedHeightMm: 105, // nhỏ → multi_up
    pageCount: 16, sheetWidthMm: 297, sheetHeightMm: 420, quantity: 100, bleedMm: 3, // A3
};

describe('applyRecommendation → store', () => {
    beforeEach(() => localStorage.clear());

    it('multi_up: đổ đúng knob, paperClassification in_nhanh, scaleMode chain_nup', () => {
        const store = createImposerSettingsStore();
        const r = recommendInNhanh(input);
        const mu = r.options.find(o => o.strategy === 'multi_up') ?? r.options[0];
        applyRecommendation(store, mu);

        const s = store.getState();
        expect(s.taskMode).toBe('booklet');
        expect(s.paperClassification).toBe('in_nhanh');
        expect(s.signatureMode).toBe('saddle');
        expect(s.customSheetWidth).toBe(297);
        expect(s.customSheetHeight).toBe(420);
        expect(s.bleed).toBe(3);
        if (mu.strategy === 'multi_up') expect(s.scaleMode).toBe('chain_nup');
    });

    it('KHÔNG đụng knob offset (foldPattern rỗng, gripperMargin mặc định)', () => {
        const store = createImposerSettingsStore();
        const r = recommendInNhanh(input);
        applyRecommendation(store, r.options[0]);
        const s = store.getState();
        expect(s.foldPattern).toBe('');          // không bật fold pattern offset
        expect(s.gripperMargin).toBe(0);          // in nhanh không nhíp
    });

    it('cut_stacks: signatureMode cut_stacks sau apply', () => {
        const store = createImposerSettingsStore();
        const r = recommendInNhanh({ ...input, binding: 'cut_stacks' });
        applyRecommendation(store, r.options[0]);
        expect(store.getState().signatureMode).toBe('cut_stacks');
    });

    it('thread: foliosize được set', () => {
        const store = createImposerSettingsStore();
        const r = recommendInNhanh({ ...input, binding: 'thread', foliosize: 8 });
        applyRecommendation(store, r.options[0]);
        expect(store.getState().foliosize).toBe(8);
        expect(store.getState().signatureMode).toBe('thread');
    });
});
