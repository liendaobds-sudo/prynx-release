import type { ImposerSlice } from '../sliceType';

export interface BookletSlice {
    signatureMode: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount';
    setSignatureMode: (v: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount') => void;
    foliosize: number;
    setFoliosize: (v: number) => void;
    paperThickness: number;
    setPaperThickness: (v: number) => void;
    gutterMargin: number;
    setGutterMargin: (v: number) => void;
    separateCover: boolean;
    setSeparateCover: (v: boolean) => void;
    coverPageCount: number;
    setCoverPageCount: (v: number) => void;
    blankPlacement: 'end' | 'center';
    setBlankPlacement: (v: 'end' | 'center') => void;
    scaleMode: '100' | 'fit' | 'chain_nup' | 'cut_stack';
    setScaleMode: (v: '100' | 'fit' | 'chain_nup' | 'cut_stack') => void;
    interleave: 'normal' | 'all_fronts_first' | 'reverse_backs' | 'reverse_backs_180';
    setInterleave: (v: 'normal' | 'all_fronts_first' | 'reverse_backs' | 'reverse_backs_180') => void;
}

export const BOOKLET_PERSIST_KEYS = [
    'signatureMode', 'foliosize', 'paperThickness', 'scaleMode', 'interleave',
    'gutterMargin', 'separateCover', 'coverPageCount', 'blankPlacement',
] as const;

export const createBookletSlice: ImposerSlice<BookletSlice> = (set) => ({
    signatureMode: 'saddle',
    setSignatureMode: (v) => set({ signatureMode: v }),
    foliosize: 16,
    setFoliosize: (v) => set({ foliosize: v }),
    paperThickness: 0,
    setPaperThickness: (v) => set({ paperThickness: v }),
    gutterMargin: 0,
    setGutterMargin: (v) => set({ gutterMargin: v }),
    separateCover: false,
    setSeparateCover: (v) => set({ separateCover: v }),
    coverPageCount: 4,
    setCoverPageCount: (v) => set({ coverPageCount: v }),
    blankPlacement: 'end',
    setBlankPlacement: (v) => set({ blankPlacement: v }),
    scaleMode: '100',
    setScaleMode: (v) => set({ scaleMode: v }),
    interleave: 'normal',
    setInterleave: (v) => set({ interleave: v }),
});
