import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import i18n, { type AppLanguage } from '../i18n';
import {
  TOOL_MENU_FULL_MIN_WIDTH,
  TOOL_MENU_FULL_DEFAULT_WIDTH,
  isToolMenuMode,
  modeFromLegacyLayout,
  normalizeFullToolMenuWidth,
  type ToolMenuMode,
} from '../lib/rightToolMenuLayout';

// ─── Persistent storage ───
// localStorage trong WebView2 nằm trong cache của WebView → bị XÓA khi update/cài lại
// (bug: công cụ yêu thích + thiết lập về mặc định sau khi cập nhật). Ghi ra file JSON
// trong AppData qua lệnh Rust (write_file_atomic / read_dir_json) — giống preset/recipe
// → bền qua mọi lần update. Fallback localStorage khi chạy dev (không có Tauri).
const STORAGE_KEY = 'pryn-x-app-settings';
const SETTINGS_FILE = 'app-settings.json';
const HOME_TOOL_MENU_WIDTH_MIN = 200;
const HOME_TOOL_MENU_WIDTH_MAX = 600;

interface QueuedStorageWrite {
  name: string;
  value: string;
}

/**
 * PERF (audit 2026-08-21 §RM.1): tuần tự hóa ghi storage và chỉ giữ snapshot
 * mới nhất trong lúc một lượt ghi đang chạy. Nhờ đó snapshot cũ không thể ghi
 * xong sau snapshot mới, đồng thời resize dồn dập không tạo hàng dài IPC/ghi đĩa.
 */
export function createLatestSettingsWriteQueue(
  writer: (write: QueuedStorageWrite) => Promise<void>,
): (name: string, value: string) => Promise<void> {
  let pendingWrite: QueuedStorageWrite | null = null;
  let activeFlush: Promise<void> | null = null;

  return (name, value) => {
    pendingWrite = { name, value };

    if (!activeFlush) {
      activeFlush = (async () => {
        while (pendingWrite) {
          const nextWrite = pendingWrite;
          pendingWrite = null;
          await writer(nextWrite);
        }
      })().finally(() => {
        activeFlush = null;
      });
    }

    return activeFlush;
  };
}

let tauriPath: typeof import('@tauri-apps/api/path') | null = null;
let invokeFn: (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>) | null = null;

async function initTauri() {
  if (tauriPath && invokeFn) return;
  try {
    tauriPath = await import('@tauri-apps/api/path');
    const core = await import('@tauri-apps/api/core');
    invokeFn = core.invoke as typeof invokeFn;
  } catch {
    /* Tauri không khả dụng (dev mode) → dùng localStorage */
  }
}

async function ensureSettingsDir(): Promise<{ dir: string; file: string } | null> {
  await initTauri();
  if (!tauriPath) return null;
  try {
    const appData = await tauriPath.appDataDir();
    // PHẢI join (appDataDir không có trailing slash trên Windows) — xem note ở presetManager.
    const dir = await tauriPath.join(appData, 'settings');
    try {
      const fs = await import('@tauri-apps/plugin-fs');
      await fs.mkdir(dir, { recursive: true });
    } catch {
      /* thư mục đã tồn tại */
    }
    const file = await tauriPath.join(dir, SETTINGS_FILE);
    return { dir, file };
  } catch {
    return null;
  }
}

async function writePersistedSettings({ name, value }: QueuedStorageWrite): Promise<void> {
  const paths = await ensureSettingsDir();
  if (paths && invokeFn) {
    try {
      await invokeFn('write_file_atomic', {
        path: paths.file,
        contents: new TextEncoder().encode(value),
      });
      return;
    } catch {
      /* fall through → localStorage */
    }
  }
  try {
    localStorage.setItem(name, value);
  } catch {
    /* bỏ qua */
  }
}

const enqueuePersistedSettingsWrite = createLatestSettingsWriteQueue(writePersistedSettings);

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    const paths = await ensureSettingsDir();
    if (paths && invokeFn) {
      try {
        // read_dir_json trả nội dung mọi .json trong dir; ta chỉ ghi 1 file duy nhất.
        const contents = await invokeFn<string[]>('read_dir_json', { dir: paths.dir });
        if (contents && contents.length > 0) return contents[0];
      } catch {
        /* fall through → thử migrate */
      }
      // Chưa có file trên đĩa → migrate dữ liệu cũ từ localStorage (lần update này).
      try {
        const legacy = localStorage.getItem(name);
        if (legacy) {
          await tauriStorage.setItem(name, legacy);
          return legacy;
        }
      } catch {
        /* bỏ qua */
      }
      return null;
    }
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => enqueuePersistedSettingsWrite(name, value),
  removeItem: async (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* bỏ qua */
    }
  },
};

interface AppSettingsState {
  hiddenTools: string[];
  favoriteTools: string[];
  defaultExportPath: string | null;
  autoRenameFormat: string;
  measurementUnit: 'mm' | 'cm' | 'inch';
  previewQuality: 'high' | 'fast';
  language: AppLanguage;
  showRulers: boolean;
  showMenuBar: boolean;
  setLanguage: (lang: AppLanguage) => void;
  toggleToolVisibility: (toolKey: string) => void;
  toggleFavoriteTool: (toolKey: string) => void;
  setDefaultExportPath: (path: string | null) => void;
  setAutoRenameFormat: (format: string) => void;
  setMeasurementUnit: (unit: 'mm' | 'cm' | 'inch') => void;
  setPreviewQuality: (quality: 'high' | 'fast') => void;
  toggleRulers: () => void;
  setShowMenuBar: (show: boolean) => void;
  toolMenuWidth: number;
  homeToolMenuWidth: number;
  toolMenuMode: ToolMenuMode;
  isToolMenuExpanded: boolean;
  isWorkspaceSidebarOpen: boolean;
  collapsedSections: Record<string, boolean>;
  setToolMenuWidth: (width: number) => void;
  setHomeToolMenuWidth: (width: number) => void;
  setToolMenuLayout: (mode: ToolMenuMode, width?: number) => void;
  openWorkspaceSidebar: (minWidth?: number) => void;
  collapseWorkspaceSidebar: () => void;
  setToolMenuExpanded: (expanded: boolean) => void;
  setWorkspaceSidebarOpen: (open: boolean) => void;
  toggleSection: (key: string) => void;
  recentFilesViewMode: 'grid' | 'list' | 'details';
  setRecentFilesViewMode: (mode: 'grid' | 'list' | 'details') => void;
}

type RightMenuSettings = Pick<
  AppSettingsState,
  | 'toolMenuWidth'
  | 'homeToolMenuWidth'
  | 'toolMenuMode'
  | 'isToolMenuExpanded'
  | 'isWorkspaceSidebarOpen'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeHomeToolMenuWidth(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(HOME_TOOL_MENU_WIDTH_MAX, Math.max(HOME_TOOL_MENU_WIDTH_MIN, numeric)));
}

function canonicalToolMenuLayout(
  mode: ToolMenuMode,
  width: unknown,
  fallbackWidth: number,
): Pick<RightMenuSettings, 'toolMenuWidth' | 'toolMenuMode' | 'isToolMenuExpanded' | 'isWorkspaceSidebarOpen'> {
  return {
    toolMenuWidth: normalizeFullToolMenuWidth(width, fallbackWidth),
    toolMenuMode: mode,
    isToolMenuExpanded: false,
    isWorkspaceSidebarOpen: mode === 'full',
  };
}

function hasSameCanonicalLayout(
  state: RightMenuSettings,
  next: ReturnType<typeof canonicalToolMenuLayout>,
): boolean {
  return state.toolMenuWidth === next.toolMenuWidth
    && state.toolMenuMode === next.toolMenuMode
    && state.isToolMenuExpanded === next.isToolMenuExpanded
    && state.isWorkspaceSidebarOpen === next.isWorkspaceSidebarOpen;
}

/** UIUX (audit 2026-08-21 §RM.9): chặn JSON cũ/hỏng làm menu nhảy hoặc tràn viewport. */
export function normalizePersistedRightMenuSettings(
  persistedState: unknown,
  fallback: RightMenuSettings,
): RightMenuSettings {
  const persisted = isRecord(persistedState) ? persistedState : {};
  const hasLegacyLayout = 'isWorkspaceSidebarOpen' in persisted || 'toolMenuWidth' in persisted;
  // UIUX (audit 2026-08-22 §RM.SIMPLE-MODE): mọi mode giữa/đóng của bản cũ
  // phải hydrate thành thanh icon, không được rơi ngược về layout full theo cờ cũ.
  const legacyMode = persisted.toolMenuMode === 'compact' || persisted.toolMenuMode === 'closed'
    ? 'icons' as const
    : null;
  const mode = legacyMode
    ?? (isToolMenuMode(persisted.toolMenuMode)
      ? persisted.toolMenuMode
      : hasLegacyLayout
        ? modeFromLegacyLayout(persisted.isWorkspaceSidebarOpen, persisted.toolMenuWidth)
        : fallback.toolMenuMode);
  // UIUX (audit 2026-08-22 §UX.MT.14): bản cũ chỉ có toolMenuWidth;
  // dùng nó làm seed một lần cho Home, sau đó giữ hai preference độc lập.
  const legacyWorkspaceWidth = typeof persisted.toolMenuWidth === 'number'
    ? persisted.toolMenuWidth
    : fallback.homeToolMenuWidth;
  const homeWidthFallback = persisted.homeToolMenuWidth === undefined
    ? legacyWorkspaceWidth
    : fallback.homeToolMenuWidth;
  const legacyHomeWidth = normalizeHomeToolMenuWidth(persisted.homeToolMenuWidth, homeWidthFallback);
  const fullWidthSource = persisted.toolMenuWidth ?? persisted.homeToolMenuWidth;

  return {
    ...canonicalToolMenuLayout(mode, fullWidthSource, fallback.toolMenuWidth),
    homeToolMenuWidth: legacyHomeWidth,
  };
}

export const useAppSettingsStore = create<AppSettingsState>()(
  persist(
    (set, get) => ({
      hiddenTools: [],
      favoriteTools: [],
      defaultExportPath: null,
      autoRenameFormat: '{original}_PrynX',
      measurementUnit: 'mm',
      previewQuality: 'high',
      language: 'vi',
      showRulers: false,
      showMenuBar: true,
      setLanguage: (lang) => {
        i18n.changeLanguage(lang);
        set({ language: lang });
      },
      toggleToolVisibility: (toolKey) => set((state) => ({
        hiddenTools: state.hiddenTools.includes(toolKey)
          ? state.hiddenTools.filter((k) => k !== toolKey)
          : [...state.hiddenTools, toolKey],
      })),
      toggleFavoriteTool: (toolKey) => set((state) => ({
        favoriteTools: state.favoriteTools.includes(toolKey)
          ? state.favoriteTools.filter((k) => k !== toolKey)
          : [...state.favoriteTools, toolKey],
      })),
      setDefaultExportPath: (path) => set({ defaultExportPath: path }),
      setAutoRenameFormat: (format) => set({ autoRenameFormat: format }),
      setMeasurementUnit: (unit) => set({ measurementUnit: unit }),
      setPreviewQuality: (quality) => set({ previewQuality: quality }),
      toggleRulers: () => set((state) => ({ showRulers: !state.showRulers })),
      setShowMenuBar: (show) => set({ showMenuBar: show }),
      toolMenuWidth: TOOL_MENU_FULL_DEFAULT_WIDTH,
      homeToolMenuWidth: 320,
      toolMenuMode: 'full',
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: true,
      collapsedSections: {},
      setToolMenuWidth: (width) => {
        const state = get();
        const normalizedWidth = normalizeFullToolMenuWidth(width, state.toolMenuWidth);
        if (normalizedWidth !== state.toolMenuWidth) set({ toolMenuWidth: normalizedWidth });
      },
      setHomeToolMenuWidth: (width) => {
        const state = get();
        const normalizedWidth = normalizeHomeToolMenuWidth(width, state.homeToolMenuWidth);
        if (normalizedWidth !== state.homeToolMenuWidth) {
          set({ homeToolMenuWidth: normalizedWidth });
        }
      },
      setToolMenuLayout: (mode, width) => {
        const state = get();
        const next = canonicalToolMenuLayout(
          mode,
          width ?? state.toolMenuWidth,
          state.toolMenuWidth,
        );
        if (!hasSameCanonicalLayout(state, next)) set(next);
      },
      openWorkspaceSidebar: (minWidth = TOOL_MENU_FULL_MIN_WIDTH) => {
        const state = get();
        const currentWidth = normalizeFullToolMenuWidth(state.toolMenuWidth);
        const requiredWidth = normalizeFullToolMenuWidth(minWidth);
        const next = canonicalToolMenuLayout(
          'full',
          Math.max(currentWidth, requiredWidth),
          currentWidth,
        );
        if (!hasSameCanonicalLayout(state, next)) set(next);
      },
      collapseWorkspaceSidebar: () => {
        const state = get();
        const next = canonicalToolMenuLayout(
          'icons',
          state.toolMenuWidth,
          state.toolMenuWidth,
        );
        if (!hasSameCanonicalLayout(state, next)) set(next);
      },
      // Alias cũ vẫn đi qua transition canonical để boolean/mode không thể lệch nhau.
      setToolMenuExpanded: (expanded) => {
        if (expanded) {
          get().openWorkspaceSidebar();
        } else {
          get().collapseWorkspaceSidebar();
        }
      },
      setWorkspaceSidebarOpen: (open) => {
        if (open) {
          get().openWorkspaceSidebar();
          return;
        }
        get().collapseWorkspaceSidebar();
      },
      toggleSection: (key) => set((state) => ({
        collapsedSections: { ...state.collapsedSections, [key]: !state.collapsedSections[key] }
      })),
      recentFilesViewMode: 'grid',
      setRecentFilesViewMode: (mode) => set({ recentFilesViewMode: mode }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => tauriStorage),
      merge: (persistedState, currentState) => {
        const persisted = isRecord(persistedState)
          ? persistedState as Partial<AppSettingsState>
          : {};
        return {
          ...currentState,
          ...persisted,
          ...normalizePersistedRightMenuSettings(persistedState, currentState),
        };
      },
      // Storage Tauri là ASYNC → ngôn ngữ đã lưu chỉ có sau khi rehydrate xong.
      // Đẩy vào i18n ở đây; lúc init i18n mặc định 'vi' nên trước khi rehydrate UI vẫn ổn.
      onRehydrateStorage: () => (state) => {
        if (state?.language && state.language !== i18n.language) {
          i18n.changeLanguage(state.language);
        }
      },
    }
  )
);
