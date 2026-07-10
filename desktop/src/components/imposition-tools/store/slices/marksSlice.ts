import type { ImposerSlice } from '../sliceType';
import type { CropMarksConfig } from '../../MarksSettingsDialog';
import { DEFAULT_MARKS_CONFIG } from '../../MarksSettingsDialog';
import { DEFAULT_PONT_CONFIG } from '../../PontSettingsDialog';
import type { PontConfig } from '../../types';
import { loadFromLocalStorage } from '../_util';

export interface MarksSlice {
    markType: 'none' | 'corners' | 'guillotine';
    setMarkType: (v: 'none' | 'corners' | 'guillotine') => void;
    cutType: 'default' | 'one_dao';
    setCutType: (v: 'default' | 'one_dao') => void;
    fillBlockGap: number;
    setFillBlockGap: (v: number) => void;
    pontType: 'none' | 'corner' | '5mm' | 'custom';
    setPontType: (v: 'none' | 'corner' | '5mm' | 'custom') => void;
    bleed: number;
    setBleed: (v: number) => void;
    showBleedView: boolean;
    setShowBleedView: (v: boolean) => void;
    // "Mở kết quả sang Tab mới" — RIÊNG theo từng công cụ (key = activeTool, hoặc
    // 'merge' cho Ghép file). Trước đây là 1 biến bool DÙNG CHUNG → tick ở công cụ này
    // rò sang công cụ khác. Map theo tool để mỗi công cụ nhớ lựa chọn độc lập.
    spawnNewTabByTool: Record<string, boolean>;
    setSpawnNewTab: (tool: string, v: boolean) => void;
    marksConfig: CropMarksConfig;
    setMarksConfig: (v: CropMarksConfig) => void;
    pontConfig: PontConfig;
    setPontConfig: (v: PontConfig | ((prev: PontConfig) => PontConfig)) => void;
    separateCutPage: boolean;
    setSeparateCutPage: (v: boolean) => void;
    pontsOnCutFile: boolean;
    setPontsOnCutFile: (v: boolean) => void;
}

export const MARKS_PERSIST_KEYS = [
    'markType', 'cutType', 'fillBlockGap', 'pontType', 'pontConfig',
    'bleed', 'spawnNewTabByTool', 'separateCutPage', 'pontsOnCutFile',
] as const;

export const createMarksSlice: ImposerSlice<MarksSlice> = (set) => ({
    markType: 'guillotine',
    setMarkType: (v) => set({ markType: v }),
    cutType: 'default',
    setCutType: (v) => set({ cutType: v }),
    fillBlockGap: 0,
    setFillBlockGap: (v) => set({ fillBlockGap: v }),
    pontType: 'none',
    setPontType: (v) => set({ pontType: v }),
    bleed: 2,
    setBleed: (v) => set({ bleed: v }),
    showBleedView: false,
    setShowBleedView: (v) => set({ showBleedView: v }),
    spawnNewTabByTool: {},
    setSpawnNewTab: (tool, v) => set((state) => ({
        spawnNewTabByTool: { ...state.spawnNewTabByTool, [tool]: v },
    })),
    marksConfig: loadFromLocalStorage<CropMarksConfig>('ps_custom_marks_config', DEFAULT_MARKS_CONFIG),
    setMarksConfig: (v) => {
        localStorage.setItem('ps_custom_marks_config', JSON.stringify(v));
        set({ marksConfig: v });
    },
    pontConfig: DEFAULT_PONT_CONFIG,
    setPontConfig: (v) => {
        set((state) => {
            const newConfig = typeof v === 'function' ? v(state.pontConfig) : v;
            return { pontConfig: newConfig };
        });
    },
    separateCutPage: true,
    setSeparateCutPage: (v) => set({ separateCutPage: v }),
    pontsOnCutFile: true,
    setPontsOnCutFile: (v) => set({ pontsOnCutFile: v }),
});
