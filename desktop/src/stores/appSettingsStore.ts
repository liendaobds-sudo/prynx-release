import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AppSettingsState {
  hiddenTools: string[];
  favoriteTools: string[];
  defaultExportPath: string | null;
  autoRenameFormat: string;
  measurementUnit: 'mm' | 'cm' | 'inch';
  previewQuality: 'high' | 'fast';
  showRulers: boolean;
  toggleToolVisibility: (toolKey: string) => void;
  toggleFavoriteTool: (toolKey: string) => void;
  setDefaultExportPath: (path: string | null) => void;
  setAutoRenameFormat: (format: string) => void;
  setMeasurementUnit: (unit: 'mm' | 'cm' | 'inch') => void;
  setPreviewQuality: (quality: 'high' | 'fast') => void;
  toggleRulers: () => void;
  toolMenuWidth: number;
  isToolMenuExpanded: boolean;
  isWorkspaceSidebarOpen: boolean;
  collapsedSections: Record<string, boolean>;
  setToolMenuWidth: (width: number) => void;
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
      toolMenuWidth: 390,
      isToolMenuExpanded: false,
      isWorkspaceSidebarOpen: true,
      collapsedSections: {},
      setToolMenuWidth: (width) => set({ toolMenuWidth: width }),
      setToolMenuExpanded: (expanded) => set({ isToolMenuExpanded: expanded }),
      setWorkspaceSidebarOpen: (open) => set({ isWorkspaceSidebarOpen: open }),
      toggleSection: (key) => set((state) => ({
        collapsedSections: { ...state.collapsedSections, [key]: !state.collapsedSections[key] }
      })),
      recentFilesViewMode: 'grid',
      setRecentFilesViewMode: (mode) => set({ recentFilesViewMode: mode }),
    }),
    {
      name: 'pryn-x-app-settings',
    }
  )
);
