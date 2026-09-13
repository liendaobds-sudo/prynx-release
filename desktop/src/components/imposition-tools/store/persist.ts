// Cấu hình persist — ghép partialize keys từ các slice + migrate giữ nguyên verbatim.
import { createJSONStorage, type PersistOptions, type StateStorage } from 'zustand/middleware';
import { DEFAULT_PONT_CONFIG } from '../pontConfigDefaults';
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
export const LEGACY_IMPOSER_PERSIST_KEY = 'ps_imposer_settings';
const SCOPED_IMPOSER_PERSIST_PREFIX = `${LEGACY_IMPOSER_PERSIST_KEY}:`;
const SCOPED_IMPOSER_GC_FLAG = 'ps_imposer_scope_gc_v1';
const pendingWrites = new Map<string, { value: string; timer: number }>();

type MigratableState = Partial<ImposerSettingsState> & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function scopedImposerPersistName(scopeKey: string): string {
    return `${SCOPED_IMPOSER_PERSIST_PREFIX}${encodeURIComponent(scopeKey)}`;
}

function writeDurable(name: string, value: string): void {
    window.localStorage.setItem(name, value);
    if (name.startsWith(SCOPED_IMPOSER_PERSIST_PREFIX)) {
        window.localStorage.setItem(LEGACY_IMPOSER_PERSIST_KEY, value);
    }
}

function flushPendingWrites(): void {
    if (typeof window === 'undefined') return;
    for (const [name, pending] of pendingWrites) {
        window.clearTimeout(pending.timer);
        try {
            writeDurable(name, pending.value);
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
                writeDurable(name, value);
                return;
            }
        } catch { /* continue with best-effort debounce */ }
        const previous = pendingWrites.get(name);
        if (previous) window.clearTimeout(previous.timer);
        const timer = window.setTimeout(() => {
            try { writeDurable(name, value); } catch { /* best effort */ }
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

export function disposeImposerPersistScope(scopeKey: string): void {
    if (typeof window === 'undefined') return;
    const name = scopedImposerPersistName(scopeKey);
    const pending = pendingWrites.get(name);
    if (pending) window.clearTimeout(pending.timer);
    pendingWrites.delete(name);
    try { window.localStorage.removeItem(name); } catch { /* best effort */ }
}

const persistStorage = createJSONStorage<Partial<ImposerSettingsState>>(() => debouncedStorage);

if (typeof window !== 'undefined') {
    try {
        if (window.localStorage.getItem(SCOPED_IMPOSER_GC_FLAG) !== '1') {
            // UIUX (audit 2026-08-25 NEW-WINDOW): cờ migration phải dùng chung
            // storage với dữ liệu; child WebView không được chạy GC lại và xóa state main.
            window.localStorage.setItem(SCOPED_IMPOSER_GC_FLAG, '1');
            const staleKeys: string[] = [];
            for (let index = 0; index < window.localStorage.length; index += 1) {
                const key = window.localStorage.key(index);
                if (key?.startsWith(SCOPED_IMPOSER_PERSIST_PREFIX)) staleKeys.push(key);
            }
            for (const key of staleKeys) window.localStorage.removeItem(key);
        }
    } catch { /* storage remains best effort */ }
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

// Migrate v1→v12 — giữ tương thích thiết lập đã lưu qua các phiên bản.
function migrate(persistedValue: unknown, version: number): Partial<ImposerSettingsState> {
    let persistedState: MigratableState = isRecord(persistedValue)
        ? persistedValue as MigratableState
        : {};
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
        const rd = (persistedState.reportDisplay || {}) as typeof DEFAULT_REPORT_CONFIG;
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
    if (version < 11) {
        // INKING (2026-08-12): bản UI thử nghiệm từng ghép xoay đối đầu
        // vào gridStrategy. Tách nó thành thiết lập độc lập mà không để
        // dropdown “Cách xếp” bị giá trị không hợp lệ sau khi nạp lại.
        const migrateLegacyInking = <T,>(value: T): T => {
            if (!isRecord(value)) return value;
            if (value.gridStrategy === 'inking_rows') {
                return {
                    ...value,
                    gridStrategy: 'simple_auto',
                    alternateRotation: value.alternateRotation || 'row',
                };
            }
            if (value.gridStrategy === 'inking_columns') {
                return {
                    ...value,
                    gridStrategy: 'simple_auto',
                    alternateRotation: value.alternateRotation || 'column',
                };
            }
            return value;
        };
        const migrated = migrateLegacyInking(persistedState);
        const profiles = { ...(migrated.toolProfiles || {}) };
        for (const tool of Object.keys(profiles)) {
            profiles[tool] = migrateLegacyInking(profiles[tool]);
        }
        persistedState = { ...migrated, toolProfiles: profiles };
    }
    if (version < 12) {
        // NEST (audit 2026-08-29 §GRIDSTRATEGY-LEAK): 'true_shape_nesting' là canary
        // die-cut/CNC. Nếu đã lưu (persist theo profile) rồi rò sang công cụ khác — nhất
        // là Bình cắt xén — hoặc còn kẹt khi bản phát hành tắt cờ, thì dropdown "Cách xếp"
        // nhận giá trị không có option và backend fail-closed mà người dùng không gỡ được
        // từ UI. Dọn giá trị đã lưu về mặc định hợp lệ (cùng lý do migration inking v11).
        // Đường chạy vẫn có `resolveGridStrategy` gác lúc hiển thị/gửi.
        const migrateLeakedNesting = <T,>(value: T): T => {
            if (!isRecord(value)) return value;
            if (value.gridStrategy === 'true_shape_nesting') {
                return { ...value, gridStrategy: 'optimal_auto' };
            }
            return value;
        };
        const migrated = migrateLeakedNesting(persistedState);
        const profiles = { ...(migrated.toolProfiles || {}) };
        for (const tool of Object.keys(profiles)) {
            profiles[tool] = migrateLeakedNesting(profiles[tool]);
        }
        persistedState = { ...migrated, toolProfiles: profiles };
    }
    // PONT-PRESET (2026-09-13): pontType từng bị lưu chuỗi 'preset_...' khi chọn mẫu,
    // làm backend API từ chối HTTP 422. Dọn về 'custom'.
    const migratePresetPontType = <T,>(value: T): T => {
        if (!isRecord(value)) return value;
        if (typeof value.pontType === 'string' && value.pontType.startsWith('preset_')) {
            return { ...value, pontType: 'custom' };
        }
        return value;
    };
    const cleaned = migratePresetPontType(persistedState);
    const cleanedProfiles = { ...(cleaned.toolProfiles || {}) };
    for (const tool of Object.keys(cleanedProfiles)) {
        cleanedProfiles[tool] = migratePresetPontType(cleanedProfiles[tool]);
    }
    persistedState = { ...cleaned, toolProfiles: cleanedProfiles };
    return persistedState;
}

export const PERSIST_CONFIG: PersistOptions<ImposerSettingsState, Partial<ImposerSettingsState>> = {
    name: LEGACY_IMPOSER_PERSIST_KEY,
    storage: persistStorage,
    version: 12,
    migrate,
    partialize: (state) => {
        const out: Record<string, unknown> = {};
        for (const k of PARTIALIZE_KEYS) out[k] = Reflect.get(state, k) as unknown;
        return out as Partial<ImposerSettingsState>;
    },
    onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (typeof state.pontType === 'string' && state.pontType.startsWith('preset_')) {
            state.pontType = 'custom';
        }
        if (state.toolProfiles) {
            for (const tool of Object.keys(state.toolProfiles)) {
                const prof = state.toolProfiles[tool];
                if (prof && typeof prof.pontType === 'string' && prof.pontType.startsWith('preset_')) {
                    prof.pontType = 'custom';
                }
            }
        }
    },
};
