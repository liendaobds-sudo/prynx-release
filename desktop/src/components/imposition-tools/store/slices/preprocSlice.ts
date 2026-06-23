import type { ImposerSlice } from '../sliceType';

export interface PreprocSlice {
    shuffleSettings: any;
    setShuffleSettings: (v: any) => void;
    resizeSettings: any;
    setResizeSettings: (v: any) => void;
    splitSettings: any;
    setSplitSettings: (v: any) => void;
}

export const createPreprocSlice: ImposerSlice<PreprocSlice> = (set) => ({
    shuffleSettings: { presetId: 'custom', rule: '', groupSize: 1, mode: 'normal' },
    setShuffleSettings: (v) => set({ shuffleSettings: v }),
    resizeSettings: { sizePresetId: 'A4', targetW: 210, targetH: 297, scaleMode: 'fit', applyTo: 'all', applyToStr: 'all' },
    setResizeSettings: (v) => set({ resizeSettings: v }),
    splitSettings: { mode: 'by_range', ranges: '', pagesPerFile: 1, pageListStr: '' },
    setSplitSettings: (v) => set({ splitSettings: v }),
});
