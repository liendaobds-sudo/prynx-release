import type { ImposerSlice } from '../sliceType';
import type { TaskMode } from '../../types';
import {
    ALGO_PROFILE_KEYS,
    DIE_CUT_SESSION_DEFAULTS,
    PROFILED_TOOLS,
    LAYOUT_TASK_TOOLS,
    normalizeProfileTaskMode,
    resolveLayoutTypeForTaskMode,
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
    /** Nạp taskMode và tuỳ chọn đơn vị bình đã nhớ cho một công cụ. */
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

            // Đồng bộ layoutType NGAY (không chờ useEffect) — tránh preview lần đầu
            // dùng layoutType='repeat' sót khi UI đã hiện "Dàn nhiều mẫu".
            const nextLayoutType = resolveLayoutTypeForTaskMode(
                layoutMode,
                (state as any).layoutType,
                tool,
            );

            const updates: Record<string, any> = {
                taskMode: layoutMode,
                layoutType: nextLayoutType,
            };

            // Ghi ngay vào profile của công cụ đang mở → mỗi tool nhớ Tác vụ riêng
            // (kể cả khi user không switch tool trước khi đóng tab).
            if (PROFILED_TOOLS.includes(tool)) {
                const stored = normalizeProfileTaskMode(layoutMode, tool);
                updates.toolProfiles = {
                    ...state.toolProfiles,
                    [tool]: {
                        ...(state.toolProfiles[tool] || {}),
                        taskMode: stored,
                        layoutType: nextLayoutType,
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
                if ('layoutType' in snap) {
                    snap.layoutType = resolveLayoutTypeForTaskMode(
                        snap.taskMode,
                        snap.layoutType,
                        prevTool,
                    );
                }
                // impositionUnit chỉ có nghĩa trong Bình tem bế. Không lưu
                // page_sheet vào profile CNC/N-Up từ state phẳng.
                snap.impositionUnit = prevTool === 'sticker_imposer'
                    && snap.impositionUnit === 'page_sheet'
                    ? 'page_sheet'
                    : 'sticker';
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
            // Luôn gán rõ để profile đích thiếu key không giữ page_sheet từ
            // Bình tem bế. Khi quay lại sticker, chỉ profile sticker phục hồi.
            updates.impositionUnit = nextTool === 'sticker_imposer'
                && restored?.impositionUnit === 'page_sheet'
                ? 'page_sheet'
                : 'sticker';

            // taskMode + layoutType phải khớp trước preview fetch đầu tiên.
            const nextTaskMode = (updates.taskMode !== undefined
                ? updates.taskMode
                : (state as any).taskMode) as string;
            const candidateLayout = updates.layoutType !== undefined
                ? updates.layoutType
                : (state as any).layoutType;
            updates.layoutType = resolveLayoutTypeForTaskMode(
                nextTaskMode,
                candidateLayout,
                nextTool,
            );
            updates.taskMode = normalizeProfileTaskMode(nextTaskMode, nextTool);

            // Dao cắt: luôn về mặc định khi vào tem bế / CNC (không nhớ 1 Dao lần trước)
            if (nextTool === 'sticker_imposer' || nextTool === 'cnc_imposer') {
                Object.assign(updates, DIE_CUT_SESSION_DEFAULTS);
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
        const rememberedUnit = state.toolProfiles[tool]?.impositionUnit;
        // Profile/preset cũ thiếu key luôn mở ở hành vi cũ an toàn: Từng tem.
        const nextUnit = tool === 'sticker_imposer' && rememberedUnit === 'page_sheet'
            ? 'page_sheet'
            : 'sticker';
        // layoutType: ưu tiên profile tool, fallback state phẳng — rồi ép khớp taskMode.
        // Trước đây chỉ nạp taskMode → layoutType='repeat' sót khiến preview Bình trang
        // dù dropdown đã là "Dàn nhiều mẫu".
        const rememberedLayout = state.toolProfiles[tool]?.layoutType;
        const nextLayoutType = resolveLayoutTypeForTaskMode(
            next,
            rememberedLayout ?? (state as any).layoutType,
            tool,
        );
        set((s) => ({
            taskMode: next,
            impositionUnit: nextUnit,
            layoutType: nextLayoutType,
            toolProfiles: {
                ...s.toolProfiles,
                [tool]: {
                    ...(s.toolProfiles[tool] || {}),
                    taskMode: next,
                    impositionUnit: nextUnit,
                    layoutType: nextLayoutType,
                },
            },
        }));
    },
});
