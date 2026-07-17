import type { ImposerSlice } from '../sliceType';
import type { TaskMode } from '../../types';
import {
    ALGO_PROFILE_KEYS,
    PROFILED_TOOLS,
    LAYOUT_TASK_TOOLS,
    normalizeProfileTaskMode,
} from '../profiles';

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
    /** Nạp taskMode đã nhớ cho một công cụ (nup / tem bế / CNC / booklet). */
    restoreTaskModeForTool: (tool: string) => void;
}

export const WORKSPACE_PERSIST_KEYS = ['taskMode', 'toolProfiles'] as const;

export const createWorkspaceSlice: ImposerSlice<WorkspaceSlice> = (set, get) => ({
    taskMode: 'nup' as TaskMode,
    setTaskMode: (mode) => {
        set((state) => {
            const tool = state.activeDashboardTool;
            // Chuẩn hoá: không persist identity công cụ như taskMode layout
            const layoutMode = (
                mode === 'sticker_imposer' || mode === 'cnc_imposer'
            ) ? 'nup' as TaskMode : mode;

            const updates: Record<string, any> = { taskMode: layoutMode };

            // Ghi ngay vào profile của công cụ đang mở → mỗi tool nhớ Tác vụ riêng
            // (kể cả khi user không switch tool trước khi đóng tab).
            if (PROFILED_TOOLS.includes(tool)) {
                const stored = normalizeProfileTaskMode(layoutMode, tool);
                updates.toolProfiles = {
                    ...state.toolProfiles,
                    [tool]: {
                        ...(state.toolProfiles[tool] || {}),
                        taskMode: stored,
                    },
                };
            }
            return updates as any;
        });
    },
    activeDashboardTool: 'none',
    setActiveDashboardTool: (tool) => set({ activeDashboardTool: tool }),
    batchOutput: null,
    setBatchOutput: (output) => set({ batchOutput: output }),
    confirmBookletSettings: null,
    setConfirmBookletSettings: (settings) => set({ confirmBookletSettings: settings }),

    toolProfiles: {},
    switchToolProfile: (prevTool, nextTool) => {
        // next phải là tool có profile; prev có thể là 'none' (lần đầu chọn từ menu)
        if (!PROFILED_TOOLS.includes(nextTool) || prevTool === nextTool) return;
        set((state) => {
            const newProfiles = { ...state.toolProfiles };

            // Lưu snapshot tool CŨ chỉ khi tool đó nằm trong PROFILED_TOOLS
            if (PROFILED_TOOLS.includes(prevTool)) {
                const snap: Record<string, any> = {};
                for (const k of ALGO_PROFILE_KEYS) snap[k] = (state as any)[k];
                if ('taskMode' in snap) {
                    snap.taskMode = normalizeProfileTaskMode(snap.taskMode, prevTool);
                }
                newProfiles[prevTool] = snap;
            }

            const updates: Record<string, any> = { toolProfiles: newProfiles };
            const restored = newProfiles[nextTool];
            if (restored) {
                for (const k of ALGO_PROFILE_KEYS) {
                    if (restored[k] !== undefined) updates[k] = restored[k];
                }
                if (updates.taskMode !== undefined) {
                    updates.taskMode = normalizeProfileTaskMode(updates.taskMode, nextTool);
                }
            } else {
                // Chưa có profile tool mới → mặc định theo loại, KHÔNG kế thừa taskMode tool cũ
                if (nextTool === 'booklet') {
                    updates.taskMode = 'booklet';
                } else if ((LAYOUT_TASK_TOOLS as readonly string[]).includes(nextTool)) {
                    updates.taskMode = 'nup';
                }
            }
            return updates as any;
        });
    },

    restoreTaskModeForTool: (tool) => {
        if (!PROFILED_TOOLS.includes(tool)) return;
        const state = get();
        const remembered = state.toolProfiles[tool]?.taskMode;
        // Profile trống (lần đầu / sau nâng cấp): tạm dùng taskMode global nếu
        // đang là nup|step_repeat, rồi seed vào profile tool đó.
        let source: unknown = remembered;
        if (source === undefined) {
            if (tool === 'booklet') source = 'booklet';
            else if (state.taskMode === 'step_repeat' || state.taskMode === 'nup') source = state.taskMode;
            else source = 'nup';
        }
        const next = normalizeProfileTaskMode(source, tool) as TaskMode;
        set((s) => ({
            taskMode: next,
            toolProfiles: {
                ...s.toolProfiles,
                [tool]: {
                    ...(s.toolProfiles[tool] || {}),
                    taskMode: next,
                },
            },
        }));
    },
});
