import type { ImposerSlice } from '../sliceType';

export interface PaperSlice {
    formsize: string;
    setFormsize: (v: string) => void;
    customSheetWidth: number;
    setCustomSheetWidth: (v: number) => void;
    customSheetHeight: number;
    setCustomSheetHeight: (v: number) => void;
    gapX: number;
    setGapX: (v: number) => void;
    gapY: number;
    setGapY: (v: number) => void;
    spreadDistribution: 'clustered' | 'even';
    setSpreadDistribution: (v: 'clustered' | 'even') => void;
    marginMode: 'labels_only' | 'include_marks';
    setMarginMode: (v: 'labels_only' | 'include_marks') => void;
    marginTop: number;
    setMarginTop: (v: number) => void;
    marginBottom: number;
    setMarginBottom: (v: number) => void;
    marginLeft: number;
    setMarginLeft: (v: number) => void;
    marginRight: number;
    setMarginRight: (v: number) => void;
    paperClassification: 'offset' | 'in_nhanh';
    setPaperClassification: (v: 'offset' | 'in_nhanh') => void;
    gripperMargin: number;
    setGripperMargin: (v: number) => void;
}

export const PAPER_PERSIST_KEYS = [
    'formsize', 'customSheetWidth', 'customSheetHeight',
    'gapX', 'gapY', 'spreadDistribution',
    'marginMode', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
    'paperClassification', 'gripperMargin',
] as const;

export const createPaperSlice: ImposerSlice<PaperSlice> = (set) => ({
    formsize: 'SRA3',
    setFormsize: (v) => set({ formsize: v }),
    customSheetWidth: 320,
    setCustomSheetWidth: (v) => set({ customSheetWidth: v }),
    customSheetHeight: 450,
    setCustomSheetHeight: (v) => set({ customSheetHeight: v }),
    gapX: 0,
    setGapX: (v) => set({ gapX: v }),
    gapY: 0,
    setGapY: (v) => set({ gapY: v }),
    spreadDistribution: 'clustered',
    setSpreadDistribution: (v) => set({ spreadDistribution: v }),
    marginMode: 'labels_only',
    setMarginMode: (v) => set({ marginMode: v }),
    marginTop: 5,
    setMarginTop: (v) => set({ marginTop: v }),
    marginBottom: 5,
    setMarginBottom: (v) => set({ marginBottom: v }),
    marginLeft: 0,
    setMarginLeft: (v) => set({ marginLeft: v }),
    marginRight: 0,
    setMarginRight: (v) => set({ marginRight: v }),
    paperClassification: 'in_nhanh',
    setPaperClassification: (v) => set({ paperClassification: v }),
    gripperMargin: 0,
    setGripperMargin: (v) => set({ gripperMargin: v }),
});
