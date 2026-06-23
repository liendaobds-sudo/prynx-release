import type { ImposerSlice } from '../sliceType';
import type { TaskMode } from '../../types';
import { ALGO_PROFILE_KEYS, PROFILED_TOOLS } from '../profiles';

export interface WorkspaceSlice {
    taskMode: TaskMode;
    setTaskMode: (mode: TaskMode) => void;
    activeDashboardTool: string;
    setActiveDashboardTool: (tool: string) => void;
    batchOutput: { docs: { blob: Blob; filename: string; report?: string }[]; mergedBlob: Blob } | null;
    setBatchOutput: (output: { docs: { blob: Blob; filename: string; report?: string }[]; mergedBlob: Blob } | null) => void;
    confirmBookletSettings: { settings: any; spawnNewTab: boolean; report: string; totalPages: number; paddedPages: number } | null;
    setConfirmBookletSettings: (settings: { settings: any; spawnNewTab: boolean; report: string; totalPages: number; paddedPages: number } | null) => void;
    toolProfiles: Record<string, Record<string, any>>;
    switchToolProfile: (prevTool: string, nextTool: string) => void;
}

export const WORKSPACE_PERSIST_KEYS = ['taskMode', 'toolProfiles'] as const;

export const createWorkspaceSlice: ImposerSlice<WorkspaceSlice> = (set) => ({
    taskMode: 'nup' as TaskMode,
    setTaskMode: (mode) => {
        set({ taskMode: mode });
    },
    activeDashboardTool: 'none',
    setActiveDashboardTool: (tool) => set({ activeDashboardTool: tool }),
    batchOutput: null,
    setBatchOutput: (output) => set({ batchOutput: output }),
    confirmBookletSettings: null,
    setConfirmBookletSettings: (settings) => set({ confirmBookletSettings: settings }),

    toolProfiles: {},
    switchToolProfile: (prevTool, nextTool) => {
        if (!PROFILED_TOOLS.includes(prevTool) || !PROFILED_TOOLS.includes(nextTool) || prevTool === nextTool) return;
        set((state) => {
            // Lưu field thuật toán hiện tại vào profile của tool CŨ
            const snap: Record<string, any> = {};
            for (const k of ALGO_PROFILE_KEYS) snap[k] = (state as any)[k];
            const newProfiles = { ...state.toolProfiles, [prevTool]: snap };
            // Nạp lại profile của tool MỚI (nếu đã có)
            const updates: Record<string, any> = { toolProfiles: newProfiles };
            const restored = newProfiles[nextTool];
            if (restored) {
                for (const k of ALGO_PROFILE_KEYS) {
                    if (restored[k] !== undefined) updates[k] = restored[k];
                }
            }
            return updates as any;
        });
    },
});
