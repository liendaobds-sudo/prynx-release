/**
 * RecipeRecorder — Ghi lại chuỗi thao tác workspace thành các RecipeStep.
 *
 * Spec: .kiro/specs/recipe-record-playback (Task 4).
 *
 * Cơ chế (theo design):
 *  - Mỗi handler (handleStart* / tool prepress) GỌI `noteOperation(opId, params)`
 *    NGAY TRƯỚC khi chạy → đặt một "pending note".
 *  - Khi thao tác hoàn tất, kết quả đi qua `commitWorkingFile`. Wrapper của
 *    commit gọi `noteCommit(extras?)` → ghép pending note + commit thành 1 Step,
 *    đẩy vào `draftSteps`, rồi xóa pending note.
 *  - Thao tác phụ thuộc file/vị trí gọi `noteNonRecordable(opId)` → Step
 *    `recordable=false` (sẽ bị bỏ qua khi phát lại).
 *
 * Dùng zustand/vanilla (singleton app-global) để vừa test được trong node,
 * vừa subscribe được trong React (hook `useRecipeRecorder`).
 */
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { RecipeOpId, RecipeStep } from './recipeTypes';
import { RECIPE_OP_META, buildRecipeStep } from './recipeOps';

/** Snapshot phụ kèm Step khi cần (chụp tại thời điểm commit). */
export interface RecorderExtras {
    viewerPageOrder?: number[];
    viewerPageRotations?: Record<number, number>;
}

interface PendingNote {
    opId: RecipeOpId;
    params: Record<string, unknown>;
    /** Ép recordable=false (cho thao tác file-dependent), bất kể metadata. */
    forceNonRecordable: boolean;
    extras?: RecorderExtras;
}

export interface RecipeRecorderState {
    isRecording: boolean;
    draftSteps: RecipeStep[];
    /** Note đang chờ commit để ghép thành Step (nội bộ). */
    pendingNote: PendingNote | null;

    /** Bắt đầu phiên ghi mới (reset draft + pending). */
    start: () => void;
    /** Kết thúc & trả về danh sách step đã ghi (đồng thời tắt ghi). */
    stop: () => RecipeStep[];
    /** Hủy phiên ghi, vứt bỏ mọi step nháp. */
    cancel: () => void;

    /** Công bố một thao tác param-based sắp chạy (chờ commit để chốt Step). */
    noteOperation: (opId: RecipeOpId, params: Record<string, unknown>, extras?: RecorderExtras) => void;
    /** Công bố một thao tác phụ thuộc file/vị trí (sẽ ghi recordable=false). */
    noteNonRecordable: (opId: RecipeOpId, extras?: RecorderExtras) => void;
    /** Tín hiệu commitWorkingFile hoàn tất → ghép pending note thành Step. */
    noteCommit: (extras?: RecorderExtras) => void;

    /** Bỏ pending note hiện tại (vd thao tác lỗi, không commit). */
    discardPending: () => void;
}

export const recipeRecorderStore = createStore<RecipeRecorderState>((set, get) => ({
    isRecording: false,
    draftSteps: [],
    pendingNote: null,

    start: () => set({ isRecording: true, draftSteps: [], pendingNote: null }),

    stop: () => {
        const steps = get().draftSteps;
        set({ isRecording: false, pendingNote: null });
        return steps;
    },

    cancel: () => set({ isRecording: false, draftSteps: [], pendingNote: null }),

    noteOperation: (opId, params, extras) => {
        if (!get().isRecording) return;
        set({
            pendingNote: {
                opId,
                params: params ?? {},
                forceNonRecordable: false,
                ...(extras ? { extras } : {}),
            },
        });
    },

    noteNonRecordable: (opId, extras) => {
        if (!get().isRecording) return;
        set({
            pendingNote: {
                opId,
                params: {},
                forceNonRecordable: true,
                ...(extras ? { extras } : {}),
            },
        });
    },

    noteCommit: (extras) => {
        const { isRecording, pendingNote, draftSteps } = get();
        if (!isRecording) return;
        // Commit không có note đi trước (undo/redo, chỉnh thủ công, hoặc tool CHƯA
        // hook noteOperation) → bỏ qua. Cảnh báo ở DEV để phát hiện thiếu hook.
        if (!pendingNote) {
            if (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV) {
                console.warn('[recipe] commit khi đang ghi nhưng KHÔNG có thao tác được công bố (noteOperation) — bỏ qua. Có thể tool này thiếu hook ghi.');
            }
            return;
        }

        const mergedExtras: RecorderExtras = { ...pendingNote.extras, ...extras };
        const step = buildRecipeStep(pendingNote.opId, pendingNote.params, mergedExtras);
        // Ép recordable=false khi thao tác tự khai báo file-dependent.
        const finalStep: RecipeStep =
            pendingNote.forceNonRecordable && step.recordable
                ? { ...step, recordable: false }
                : step;

        set({ draftSteps: [...draftSteps, finalStep], pendingNote: null });
    },

    discardPending: () => set({ pendingNote: null }),
}));

// ─────────────────────────── Convenience API (non-React) ───────────────────────────

export const recipeRecorder = {
    get state() { return recipeRecorderStore.getState(); },
    get isRecording() { return recipeRecorderStore.getState().isRecording; },
    get draftSteps() { return recipeRecorderStore.getState().draftSteps; },
    start: () => recipeRecorderStore.getState().start(),
    stop: () => recipeRecorderStore.getState().stop(),
    cancel: () => recipeRecorderStore.getState().cancel(),
    noteOperation: (opId: RecipeOpId, params: Record<string, unknown>, extras?: RecorderExtras) =>
        recipeRecorderStore.getState().noteOperation(opId, params, extras),
    noteNonRecordable: (opId: RecipeOpId, extras?: RecorderExtras) =>
        recipeRecorderStore.getState().noteNonRecordable(opId, extras),
    noteCommit: (extras?: RecorderExtras) => recipeRecorderStore.getState().noteCommit(extras),
    discardPending: () => recipeRecorderStore.getState().discardPending(),
};

// ─────────────────────────── React hook ───────────────────────────

/** Hook subscribe selector tới recorder store (dùng trong component React). */
export function useRecipeRecorder<T>(selector: (s: RecipeRecorderState) => T): T {
    return useStore(recipeRecorderStore, selector);
}

/** Tiện ích: lấy danh sách opId đã có metadata (để validate ở call-site). */
export function isKnownRecipeOp(opId: string): opId is RecipeOpId {
    return Object.prototype.hasOwnProperty.call(RECIPE_OP_META, opId);
}
