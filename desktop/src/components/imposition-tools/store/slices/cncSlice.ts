import type { ImposerSlice } from '../sliceType';

export interface SavePrintConfig {
    nameMode: 'report' | 'number' | 'original';
    folderMode: 'per_order' | 'flat';
    includeOrderCode: boolean;
    includeDate: boolean;
    lastFolder: string;
    autoSave: boolean;
}

export interface CncSlice {
    cncFlipEdge: 'long' | 'short';
    setCncFlipEdge: (v: 'long' | 'short') => void;
    cncDuplexMarks: boolean;
    setCncDuplexMarks: (v: boolean) => void;
    savePrint: SavePrintConfig;
    setSavePrint: (v: Partial<SavePrintConfig>) => void;
}

export const CNC_PERSIST_KEYS = ['savePrint', 'cncFlipEdge', 'cncDuplexMarks'] as const;

export const createCncSlice: ImposerSlice<CncSlice> = (set) => ({
    cncFlipEdge: 'long',
    setCncFlipEdge: (v) => set({ cncFlipEdge: v }),
    cncDuplexMarks: true,
    setCncDuplexMarks: (v) => set({ cncDuplexMarks: v }),
    savePrint: { nameMode: 'report', folderMode: 'per_order', includeOrderCode: true, includeDate: false, lastFolder: '', autoSave: false },
    setSavePrint: (v) => set((state) => ({ savePrint: { ...state.savePrint, ...v } })),
});
