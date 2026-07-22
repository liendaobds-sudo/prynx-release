// Cấu hình persist — ghép partialize keys từ các slice + migrate giữ nguyên verbatim.
import { createJSONStorage, type PersistOptions, type StateStorage } from 'zustand/middleware';
import { DEFAULT_PONT_CONFIG } from '../PontSettingsDialog';
import { DEFAULT_BOOK_REPORT_CONFIG, DEFAULT_REPORT_CONFIG } from '../types';
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
import { PREPROC_PERSIST_KEYS, DEFAULT_RESIZE_SETTINGS } from './slices/preprocSlice';

const PERSIST_DEBOUNCE_MS = 150;
const pendingWrites = new Map<string, { value: string; timer: number }>();

function flushPendingWrites(): void {
    if (typeof window === 'undefined') return;
    for (const [name, pending] of pendingWrites) {
        window.clearTimeout(pending.timer);
        try {
            window.localStorage.setItem(name, pending.value);
        } catch {
            // Storage failures must not break the editor.
        }
        pendingWrites.delete(name);
    }
}

const debouncedStorage: StateStorage = {
    getItem: (name) => {
        if (typeof window === 'undefined') return null;
        try { return window.localStorage.getItem(name); } catch { return null; }
    },
    setItem: (name, value) => {
        if (typeof window === 'undefined') return;
        try {
            // Keep the first durable write synchronous so a newly created key is
            // never lost if the app closes immediately; subsequent bursts debounce.
            if (!pendingWrites.has(name) && window.localStorage.getItem(name) === null) {
                window.localStorage.setItem(name, value);
                return;
            }
        } catch { /* continue with best-effort debounce */ }
        const previous = pendingWrites.get(name);
        if (previous) window.clearTimeout(previous.timer);
        const timer = window.setTimeout(() => {
            try { window.localStorage.setItem(name, value); } catch { /* best effort */ }
            pendingWrites.delete(name);
        }, PERSIST_DEBOUNCE_MS);
        pendingWrites.set(name, { value, timer });
    },
    removeItem: (name) => {
        if (typeof window === 'undefined') return;
        const previous = pendingWrites.get(name);
        if (previous) window.clearTimeout(previous.timer);
        pendingWrites.delete(name);
        try { window.localStorage.removeItem(name); } catch { /* best effort */ }
    },
};

const persistStorage = createJSONStorage<Partial<ImposerSettingsState>>(() => debouncedStorage);

if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushPendingWrites);
}
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
    ...PREPROC_PERSIST_KEYS,
];

// Migrate v1→v8 — GIỮ NGUYÊN verbatim từ store monolith (hành vi không đổi).
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
    if (version < 8) {
        // v7 → v8: nhớ thiết lập Co giãn trang (resize) giữa các lần chạy
        persistedState = {
            ...persistedState,
            resizeSettings: {
                ...DEFAULT_RESIZE_SETTINGS,
                ...(persistedState.resizeSettings || {}),
            },
        };
    }
    if (version < 9) {
        // v8 → v9: dao cắt (cutType/dieSize*) không còn nhớ — luôn mặc định session
        const rest = { ...(persistedState || {}) };
        delete rest.cutType;
        delete rest.dieSizeMode;
        delete rest.dieOffsetMm;
        const profiles = { ...(rest.toolProfiles || {}) };
        for (const tool of Object.keys(profiles)) {
            if (!profiles[tool] || typeof profiles[tool] !== 'object') continue;
            const profile = { ...profiles[tool] };
            delete profile.cutType;
            delete profile.dieSizeMode;
            delete profile.dieOffsetMm;
            profiles[tool] = profile;
        }
        persistedState = { ...rest, toolProfiles: profiles };
    }
    if (version < 10) {
        persistedState = {
            ...persistedState,
            bookReportDisplay: {
                ...DEFAULT_BOOK_REPORT_CONFIG,
                ...(persistedState.bookReportDisplay || {}),
            },
        };
    }
    return persistedState;
}

export const PERSIST_CONFIG: PersistOptions<ImposerSettingsState, Partial<ImposerSettingsState>> = {
    name: 'ps_imposer_settings',
    storage: persistStorage,
    version: 10,
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
