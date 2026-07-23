/**
 * Zustand Store for Imposition Settings — COMPOSED FROM SLICES.
 *
 * Trước đây là 1 file monolith ~650 dòng gom mọi domain. Đã tách thành các slice
 * theo domain ở `./store/slices/*` để thay đổi một tính năng không lẫn diff sang
 * tính năng khác (spec: imposer-store-slicing).
 *
 * BẤT BIẾN: state vẫn PHẲNG (giao của các slice), public API (Context + hook +
 * createImposerSettingsStore) giữ NGUYÊN, persist/migration/partialize/tool-profiles
 * không đổi hành vi. Consumer KHÔNG cần sửa.
 *
 *   store/
 *     types.ts      — ImposerSettingsState = giao các slice
 *     persist.ts    — name/version/migrate/partialize
 *     profiles.ts   — ALGO_PROFILE_KEYS + PROFILED_TOOLS
 *     slices/*.ts   — paper, marks, report, cnc, booklet, nup, fold, catalog, ui, preproc, workspace
 */
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createContext, useContext } from 'react';
import type { StoreApi } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ImposerSettingsState } from './store/types';
export type { ImposerSettingsState } from './store/types';

import { LEGACY_IMPOSER_PERSIST_KEY, PERSIST_CONFIG, scopedImposerPersistName } from './store/persist';
import { createWorkspaceSlice } from './store/slices/workspaceSlice';
import { createPaperSlice } from './store/slices/paperSlice';
import { createMarksSlice } from './store/slices/marksSlice';
import { createReportSlice } from './store/slices/reportSlice';
import { createCncSlice } from './store/slices/cncSlice';
import { createBookletSlice } from './store/slices/bookletSlice';
import { createNupSlice } from './store/slices/nupSlice';
import { createFoldSlice } from './store/slices/foldSlice';
import { createCatalogSlice } from './store/slices/catalogSlice';
import { createUiSlice } from './store/slices/uiSlice';
import { createPreprocSlice } from './store/slices/preprocSlice';


// ─── Store Definition (ghép slice + persist) ────────────────────────────────

export const createImposerSettingsStore = (scopeKey?: string) => {
    const scopedName = scopeKey
        ? scopedImposerPersistName(scopeKey)
        : PERSIST_CONFIG.name;
    if (scopeKey && typeof window !== 'undefined') {
        try {
            // Seed each scoped store from the legacy shared preferences once, so
            // this performance fix does not silently reset existing users.
            if (window.localStorage.getItem(scopedName) === null) {
                const legacy = window.localStorage.getItem(LEGACY_IMPOSER_PERSIST_KEY);
                if (legacy !== null) window.localStorage.setItem(scopedName, legacy);
            }
        } catch { /* storage remains best effort */ }
    }
    const persistConfig = scopeKey
        ? { ...PERSIST_CONFIG, name: scopedName }
        : PERSIST_CONFIG;

    return createStore<ImposerSettingsState>()(
    persist(
        (...a) => ({
            ...createWorkspaceSlice(...a),
            ...createPaperSlice(...a),
            ...createMarksSlice(...a),
            ...createReportSlice(...a),
            ...createCncSlice(...a),
            ...createBookletSlice(...a),
            ...createNupSlice(...a),
            ...createFoldSlice(...a),
            ...createCatalogSlice(...a),
            ...createUiSlice(...a),
            ...createPreprocSlice(...a),
        }),
        persistConfig,
    ));
};


// ─── React Context + Hook (public API — giữ nguyên) ─────────────────────────

export const ImposerSettingsContext = createContext<StoreApi<ImposerSettingsState> | null>(null);

export function useImposerSettingsStore<T = ImposerSettingsState>(selector?: (state: ImposerSettingsState) => T): T {
    const store = useContext(ImposerSettingsContext);
    if (!store) throw new Error('Missing ImposerSettingsContext.Provider in the tree');
    return useStore(store, selector!) as T;
}
