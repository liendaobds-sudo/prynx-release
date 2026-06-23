// Cấu hình persist — ghép partialize keys từ các slice + migrate giữ nguyên verbatim.
import type { PersistOptions } from 'zustand/middleware';
import { DEFAULT_PONT_CONFIG } from '../PontSettingsDialog';
import { DEFAULT_REPORT_CONFIG } from '../types';
import type { ImposerSettingsState } from './types';

import { PAPER_PERSIST_KEYS } from './slices/paperSlice';
import { MARKS_PERSIST_KEYS } from './slices/marksSlice';
import { BOOKLET_PERSIST_KEYS } from './slices/bookletSlice';
import { NUP_PERSIST_KEYS } from './slices/nupSlice';
import { FOLD_PERSIST_KEYS } from './slices/foldSlice';
import { CATALOG_PERSIST_KEYS } from './slices/catalogSlice';
import { REPORT_PERSIST_KEYS } from './slices/reportSlice';
import { CNC_PERSIST_KEYS } from './slices/cncSlice';
import { WORKSPACE_PERSIST_KEYS } from './slices/workspaceSlice';

/** Tập field được lưu vào localStorage — ghép từ khai báo của từng slice. */
export const PARTIALIZE_KEYS: readonly string[] = [
    ...WORKSPACE_PERSIST_KEYS,
    ...PAPER_PERSIST_KEYS,
    ...MARKS_PERSIST_KEYS,
    ...BOOKLET_PERSIST_KEYS,
    ...NUP_PERSIST_KEYS,
    ...FOLD_PERSIST_KEYS,
    ...CATALOG_PERSIST_KEYS,
    ...REPORT_PERSIST_KEYS,
    ...CNC_PERSIST_KEYS,
];

// Migrate v1→v7 — GIỮ NGUYÊN verbatim từ store monolith (hành vi không đổi).
function migrate(persistedState: any, version: number): any {
    if (version < 2) {
        // v1 → v2: add pontConfig to persisted state
        persistedState = { ...persistedState, pontConfig: persistedState.pontConfig || DEFAULT_PONT_CONFIG };
    }
    if (version < 3) {
        // v2 → v3: thêm toolProfiles (chống rò rỉ state giữa công cụ)
        persistedState = { ...persistedState, toolProfiles: persistedState.toolProfiles || {} };
    }
    if (version < 4) {
        // v3 → v4: thêm cấu hình report + xuất tờ duy nhất
        persistedState = {
            ...persistedState,
            exportUniqueSheets: persistedState.exportUniqueSheets ?? true,
            reportDisplay: persistedState.reportDisplay || DEFAULT_REPORT_CONFIG,
            customMaterials: persistedState.customMaterials || [],
        };
    }
    if (version < 5) {
        // v4 → v5: thêm cấu hình lưu file in
        persistedState = {
            ...persistedState,
            savePrint: persistedState.savePrint || { nameMode: 'report', folderMode: 'per_order', includeOrderCode: true, includeDate: false, lastFolder: '', autoSave: false },
        };
    }
    if (version < 6) {
        // v5 → v6: thêm cấu hình Bình Bế Rớt (CNC)
        persistedState = {
            ...persistedState,
            cncFlipEdge: persistedState.cncFlipEdge || 'long',
            cncDuplexMarks: persistedState.cncDuplexMarks ?? true,
        };
    }
    if (version < 7) {
        // v6 → v7: thêm showGangCount + gangCount vào reportDisplay
        const rd = persistedState.reportDisplay || {};
        if (rd.showGangCount === undefined) rd.showGangCount = true;
        const fo = rd.fieldOrder || [];
        if (!fo.includes('gangCount')) {
            const idx = fo.indexOf('identifier');
            if (idx >= 0) fo.splice(idx + 1, 0, 'gangCount');
            else fo.push('gangCount');
        }
        rd.fieldOrder = fo;
        persistedState = { ...persistedState, reportDisplay: rd };
    }
    return persistedState;
}

export const PERSIST_CONFIG: PersistOptions<ImposerSettingsState, Partial<ImposerSettingsState>> = {
    name: 'ps_imposer_settings',
    version: 7,
    migrate,
    partialize: (state) => {
        const out: Record<string, any> = {};
        for (const k of PARTIALIZE_KEYS) out[k] = (state as any)[k];
        return out as Partial<ImposerSettingsState>;
    },
    onRehydrateStorage: () => () => {
        // Silently rehydrate
    },
};
