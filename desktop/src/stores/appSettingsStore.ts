import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';

// ─── Persistent storage ───
// localStorage trong WebView2 nằm trong cache của WebView → bị XÓA khi update/cài lại
// (bug: công cụ yêu thích + thiết lập về mặc định sau khi cập nhật). Ghi ra file JSON
// trong AppData qua lệnh Rust (write_file_atomic / read_dir_json) — giống preset/recipe
// → bền qua mọi lần update. Fallback localStorage khi chạy dev (không có Tauri).
const STORAGE_KEY = 'pryn-x-app-settings';
const SETTINGS_FILE = 'app-settings.json';

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
  setItem: async (name, value) => {
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
  },
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
  showRulers: boolean;
  showMenuBar: boolean;
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
  isToolMenuExpanded: boolean;
  isWorkspaceSidebarOpen: boolean;
  collapsedSections: Record<string, boolean>;
  setToolMenuWidth: (width: number) => void;
  setHomeToolMenuWidth: (width: number) => void;
  setToolMenuExpanded: (expanded: boolean) => void;
  setWorkspaceSidebarOpen: (open: boolean) => void;
  toggleSection: (key: string) => void;
  recentFilesViewMode: 'grid' | 'list' | 'details';
  setRecentFilesViewMode: (mode: 'grid' | 'list' | 'details') => void;
}

export const useAppSettingsStore = create<AppSettingsState>()(
  persist(
    (set) => ({
      hiddenTools: [],
      favoriteTools: [],
      defaultExportPath: null,
      autoRenameFormat: '{original}_PrynX',
      measurementUnit: 'mm',
      previewQuality: 'high',
      showRulers: false,
      showMenuBar: true,
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
      toolMenuWidth: 390,
      homeToolMenuWidth: 320,
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: true,
      collapsedSections: {},
      setToolMenuWidth: (width) => set({ toolMenuWidth: width }),
      setHomeToolMenuWidth: (width) => set({ homeToolMenuWidth: width }),
      setToolMenuExpanded: (expanded) => set({ isToolMenuExpanded: expanded }),
      setWorkspaceSidebarOpen: (open) => set({ isWorkspaceSidebarOpen: open }),
      toggleSection: (key) => set((state) => ({
        collapsedSections: { ...state.collapsedSections, [key]: !state.collapsedSections[key] }
      })),
      recentFilesViewMode: 'grid',
      setRecentFilesViewMode: (mode) => set({ recentFilesViewMode: mode }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => tauriStorage),
    }
  )
);
