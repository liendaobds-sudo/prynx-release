import type { ImposerSlice } from '../sliceType';
import type { NupSettings } from '../../types';

export type ImpositionUnit = 'sticker' | 'page_sheet';

export interface NupSlice {
    impositionUnit: ImpositionUnit;
    setImpositionUnit: (v: ImpositionUnit) => void;
    layoutType: 'repeat' | 'sequential' | 'cut_stacks' | 'ratio_stack';
    setLayoutType: (v: 'repeat' | 'sequential' | 'cut_stacks' | 'ratio_stack') => void;
    columns: number;
    setColumns: (v: number) => void;
    rows: number;
    setRows: (v: number) => void;
    gridStrategy: NupSettings['gridStrategy'];
    setGridStrategy: (v: NupSettings['gridStrategy']) => void;
    groupingStrategy: 'maximize_area' | 'strict_ratio' | 'cluster_tile' | 'none';
    setGroupingStrategy: (v: 'maximize_area' | 'strict_ratio' | 'cluster_tile' | 'none') => void;
    clusterCombineMode: 'replicate_mixed' | 'zone_per_type' | 'zone_ratio';
    setClusterCombineMode: (v: 'replicate_mixed' | 'zone_per_type' | 'zone_ratio') => void;
    clusterTileW: number;
    setClusterTileW: (v: number) => void;
    clusterTileH: number;
    setClusterTileH: (v: number) => void;
    clusterSizingMode: 'dims' | 'split_cols' | 'split_rows';
    setClusterSizingMode: (v: 'dims' | 'split_cols' | 'split_rows') => void;
    clusterCols: number;
    setClusterCols: (v: number) => void;
    clusterRows: number;
    setClusterRows: (v: number) => void;
    tileGapX: number;
    setTileGapX: (v: number) => void;
    tileGapY: number;
    setTileGapY: (v: number) => void;
    clusterNesting: boolean;
    setClusterNesting: (v: boolean) => void;
    showGapSettings: boolean;
    setShowGapSettings: (v: boolean) => void;
    duplexFlow: 'normal' | 'double';
    setDuplexFlow: (v: 'normal' | 'double') => void;
    align: NupSettings['align'];
    setAlign: (v: NupSettings['align']) => void;
    clusterMode: 'none' | 'row' | 'column';
    setClusterMode: (v: 'none' | 'row' | 'column') => void;
    clusterCount: number;
    setClusterCount: (v: number) => void;
    clusterGap: number;
    setClusterGap: (v: number) => void;
    clusterGapMode: 'item' | 'mark';
    setClusterGapMode: (v: 'item' | 'mark') => void;
    clusterDistribution: 'default' | 'type';
    setClusterDistribution: (v: 'default' | 'type') => void;
    clusterBorder: boolean;
    setClusterBorder: (v: boolean) => void;
    targetQuantity: number;
    setTargetQuantity: (v: number) => void;
    targetQuantitiesByPage: Record<number, number>;
    setTargetQuantitiesByPage: (v: Record<number, number>) => void;
    previewCapacity: number;
    setPreviewCapacity: (v: number) => void;
    previewCapacities: Record<number, number>;
    setPreviewCapacities: (v: Record<number, number>) => void;
    mixedPlacedByPage: Record<number, number>;
    setMixedPlacedByPage: (v: Record<number, number>) => void;
    fetchEpoch: number;
    setFetchEpoch: (v: number | ((prev: number) => number)) => void;
}

export const NUP_PERSIST_KEYS = [
    'impositionUnit',
    'layoutType', 'columns', 'rows', 'gridStrategy', 'groupingStrategy',
    'clusterCombineMode',
    'clusterTileW', 'clusterTileH', 'clusterSizingMode', 'clusterCols', 'clusterRows',
    'tileGapX', 'tileGapY', 'clusterNesting', 'duplexFlow', 'align',
    'clusterMode', 'clusterCount', 'clusterGap', 'clusterGapMode', 'clusterDistribution',
    'clusterBorder',
] as const;

export const createNupSlice: ImposerSlice<NupSlice> = (set) => ({
    impositionUnit: 'sticker',
    setImpositionUnit: (v) => set((state) => {
        // This preference belongs only to Bình tem bế. Persist it in that
        // tool profile immediately so closing the tab cannot lose it.
        if (state.activeDashboardTool !== 'sticker_imposer') {
            return { impositionUnit: 'sticker' };
        }
        return {
            impositionUnit: v,
            toolProfiles: {
                ...state.toolProfiles,
                sticker_imposer: {
                    ...(state.toolProfiles.sticker_imposer || {}),
                    impositionUnit: v,
                },
            },
        };
    }),
    layoutType: 'sequential',
    setLayoutType: (v) => set({ layoutType: v }),
    columns: 0,
    setColumns: (v) => set({ columns: v }),
    rows: 0,
    setRows: (v) => set({ rows: v }),
    gridStrategy: 'optimal_auto',
    setGridStrategy: (v) => set({ gridStrategy: v }),
    groupingStrategy: 'maximize_area',
    setGroupingStrategy: (v) => set({ groupingStrategy: v }),
    clusterCombineMode: 'replicate_mixed',
    setClusterCombineMode: (v) => set({ clusterCombineMode: v }),
    clusterTileW: 148,
    setClusterTileW: (v) => set({ clusterTileW: v }),
    clusterTileH: 210,
    setClusterTileH: (v) => set({ clusterTileH: v }),
    clusterSizingMode: 'dims',
    setClusterSizingMode: (v) => set({ clusterSizingMode: v }),
    clusterCols: 2,
    setClusterCols: (v) => set({ clusterCols: v }),
    clusterRows: 2,
    setClusterRows: (v) => set({ clusterRows: v }),
    tileGapX: 0,
    setTileGapX: (v) => set({ tileGapX: v }),
    tileGapY: 0,
    setTileGapY: (v) => set({ tileGapY: v }),
    clusterNesting: true,
    setClusterNesting: (v) => set({ clusterNesting: v }),
    showGapSettings: false,
    setShowGapSettings: (v) => set({ showGapSettings: v }),
    duplexFlow: 'normal',
    setDuplexFlow: (v) => set({ duplexFlow: v }),
    align: 'center',
    setAlign: (v) => set({ align: v }),
    clusterMode: 'none',
    setClusterMode: (v) => set({ clusterMode: v }),
    clusterCount: 2,
    setClusterCount: (v) => set({ clusterCount: v }),
    clusterGap: 10,
    setClusterGap: (v) => set({ clusterGap: v }),
    clusterGapMode: 'mark',
    setClusterGapMode: (v) => set({ clusterGapMode: v }),
    clusterDistribution: 'default',
    setClusterDistribution: (v) => set({ clusterDistribution: v }),
    clusterBorder: false,
    setClusterBorder: (v) => set({ clusterBorder: v }),
    targetQuantity: 0,
    setTargetQuantity: (v) => set({ targetQuantity: v }),
    targetQuantitiesByPage: {},
    setTargetQuantitiesByPage: (v) => set({ targetQuantitiesByPage: v }),
    previewCapacity: 0,
    setPreviewCapacity: (v) => set({ previewCapacity: v }),
    previewCapacities: {},
    setPreviewCapacities: (v) => set({ previewCapacities: v }),
    mixedPlacedByPage: {},
    setMixedPlacedByPage: (v) => set({ mixedPlacedByPage: v }),
    fetchEpoch: 0,
    setFetchEpoch: (v) => {
        set((state) => ({
            fetchEpoch: typeof v === 'function' ? v(state.fetchEpoch) : v,
        }));
    },
});
