import type { ImposerSlice } from '../sliceType';
import type { PlateJob } from '../../../../lib/imposerEngine/CatalogPlanner';
import type { OptimizationResult } from '../../../../lib/imposerEngine/SheetOptimizer';

export interface CatalogSlice {
    autoCatalog: boolean;
    setAutoCatalog: (v: boolean) => void;
    catalogHasCover: boolean;
    setCatalogHasCover: (v: boolean) => void;
    catalogMasterSigOverride: 'auto' | '16' | '8' | '4';
    setCatalogMasterSigOverride: (v: 'auto' | '16' | '8' | '4') => void;
    catalogRemainderPlacement: 'outside' | 'inside';
    setCatalogRemainderPlacement: (v: 'outside' | 'inside') => void;
    sourcePageDim: { w: number; h: number } | null;
    setSourcePageDim: (v: { w: number; h: number } | null) => void;
    sourcePageDims: { w: number; h: number }[];
    setSourcePageDims: (v: { w: number; h: number }[]) => void;
    /** MediaBox/page.rect dimensions used only by whole-sheet decal geometry. */
    sourceMediaPageDim: { w: number; h: number } | null;
    setSourceMediaPageDim: (v: { w: number; h: number } | null) => void;
    sourceMediaPageDims: { w: number; h: number }[];
    setSourceMediaPageDims: (v: { w: number; h: number }[]) => void;
    optimalData: OptimizationResult | null;
    setOptimalData: (v: OptimizationResult | null) => void;
    catalogPreview: string;
    setCatalogPreview: (v: string) => void;
    catalogJobsState: PlateJob[] | null;
    setCatalogJobsState: (v: PlateJob[] | null) => void;
}

export const CATALOG_PERSIST_KEYS = [
    'autoCatalog', 'catalogHasCover', 'catalogMasterSigOverride', 'catalogRemainderPlacement',
] as const;

export const createCatalogSlice: ImposerSlice<CatalogSlice> = (set) => ({
    autoCatalog: false,
    setAutoCatalog: (v) => set({ autoCatalog: v }),
    catalogHasCover: true,
    setCatalogHasCover: (v) => set({ catalogHasCover: v }),
    catalogMasterSigOverride: 'auto',
    setCatalogMasterSigOverride: (v) => set({ catalogMasterSigOverride: v }),
    catalogRemainderPlacement: 'outside',
    setCatalogRemainderPlacement: (v) => set({ catalogRemainderPlacement: v }),
    sourcePageDim: null,
    setSourcePageDim: (v) => set({ sourcePageDim: v }),
    sourcePageDims: [],
    setSourcePageDims: (v) => set({ sourcePageDims: v }),
    sourceMediaPageDim: null,
    setSourceMediaPageDim: (v) => set({ sourceMediaPageDim: v }),
    sourceMediaPageDims: [],
    setSourceMediaPageDims: (v) => set({ sourceMediaPageDims: v }),
    optimalData: null,
    setOptimalData: (v) => set({ optimalData: v }),
    catalogPreview: '',
    setCatalogPreview: (v) => set({ catalogPreview: v }),
    catalogJobsState: null,
    setCatalogJobsState: (v) => set({ catalogJobsState: v }),
});
