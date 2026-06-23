import type { ImposerSlice } from '../sliceType';

export interface FoldSlice {
    foldPattern: string;
    setFoldPattern: (v: string) => void;
}

export const FOLD_PERSIST_KEYS = ['foldPattern'] as const;

export const createFoldSlice: ImposerSlice<FoldSlice> = (set) => ({
    foldPattern: '',
    setFoldPattern: (v) => set({ foldPattern: v }),
});
