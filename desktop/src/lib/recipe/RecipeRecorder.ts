/**
 * RecipeRecorder — ghép thao tác đã công bố với đúng lượt commit của nó.
 *
 * Recorder là singleton toàn ứng dụng, vì vậy mỗi pending note bắt buộc mang vé nội bộ
 * gồm tab sở hữu, phiên ghi và thao tác. Vé chỉ dùng để chống race; tuyệt đối không được
 * ghi vào RecipeStep/JSON.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { RecipeOpId, RecipeStep } from './recipeTypes';
import { RECIPE_OP_META, buildRecipeStep } from './recipeOps';

/** Snapshot phụ kèm Step khi cần, chụp tại thời điểm commit. */
export interface RecorderExtras {
    viewerPageOrder?: number[];
    /** Góc xoay theo vị trí trang trong pageOrder. */
    viewerPageRotations?: number[];
}

/** Vé nhân quả nội bộ; không thuộc schema Recipe. */
export type RecipeOperationTicket = Readonly<{
    ownerTabId: string;
    sessionId: number;
    operationId: number;
}>;

interface PendingNote {
    ticket: RecipeOperationTicket;
    opId: RecipeOpId;
    params: Record<string, unknown>;
    forceNonRecordable: boolean;
    extras?: RecorderExtras;
}

function sameTicket(
    left: RecipeOperationTicket | null | undefined,
    right: RecipeOperationTicket | null | undefined,
): boolean {
    return !!left
        && !!right
        && left.ownerTabId === right.ownerTabId
        && left.sessionId === right.sessionId
        && left.operationId === right.operationId;
}

export interface RecipeRecorderState {
    isRecording: boolean;
    ownerTabId: string | null;
    activeTabId: string | null;
    sessionId: number;
    draftSteps: RecipeStep[];
    /** Note đang chờ commit; chỉ công khai để quan sát trạng thái, không dùng làm token. */
    pendingNote: PendingNote | null;

    start: (ownerTabId: string) => boolean;
    stop: (ownerTabId: string) => RecipeStep[] | null;
    cancel: (ownerTabId: string) => boolean;
    setTabActive: (tabId: string, active: boolean) => void;
    isRecordingFor: (tabId: string) => boolean;

    noteOperation: (
        opId: RecipeOpId,
        params: Record<string, unknown>,
        extras?: RecorderExtras,
        ownerTabId?: string,
    ) => RecipeOperationTicket | null;
    noteNonRecordable: (
        opId: RecipeOpId,
        extras?: RecorderExtras,
        ownerTabId?: string,
    ) => RecipeOperationTicket | null;
    pendingTicketFor: (tabId: string) => RecipeOperationTicket | null;
    /**
     * Cho phép publish working file khi không ghi ở tab này, hoặc khi caller giữ
     * đúng vé đang chờ của chính phiên/tab đó.
     */
    canCommitWorkingFile: (
        tabId: string,
        ticket?: RecipeOperationTicket | null,
    ) => boolean;
    noteCommit: (
        ticket: RecipeOperationTicket | null,
        extras?: RecorderExtras,
    ) => boolean;
    /**
     * Chỉ ticket tường minh mới được xóa pending. `undefined`/`null` luôn là no-op.
     */
    discardPending: (ticket?: RecipeOperationTicket | null) => boolean;
}

let nextSessionId = 0;
let nextOperationId = 0;

export const recipeRecorderStore = createStore<RecipeRecorderState>((set, get) => {
    const createPending = (
        opId: RecipeOpId,
        params: Record<string, unknown>,
        forceNonRecordable: boolean,
        extras?: RecorderExtras,
        requestedOwnerTabId?: string,
    ): RecipeOperationTicket | null => {
        const state = get();
        const ownerTabId = requestedOwnerTabId;
        if (
            !state.isRecording
            || !ownerTabId
            || ownerTabId !== state.ownerTabId
            || state.pendingNote
        ) {
            return null;
        }

        const ticket: RecipeOperationTicket = Object.freeze({
            ownerTabId,
            sessionId: state.sessionId,
            operationId: ++nextOperationId,
        });
        set({
            pendingNote: {
                ticket,
                opId,
                params,
                forceNonRecordable,
                ...(extras ? { extras } : {}),
            },
        });
        return ticket;
    };

    return {
        isRecording: false,
        ownerTabId: null,
        activeTabId: null,
        sessionId: 0,
        draftSteps: [],
        pendingNote: null,

        start: (ownerTabId) => {
            if (!ownerTabId || get().isRecording) return false;
            const sessionId = ++nextSessionId;
            set({
                isRecording: true,
                ownerTabId,
                activeTabId: ownerTabId,
                sessionId,
                draftSteps: [],
                pendingNote: null,
            });
            return true;
        },

        stop: (ownerTabId) => {
            const state = get();
            if (!state.isRecording || state.ownerTabId !== ownerTabId) return null;
            const steps = [...state.draftSteps];
            set({ isRecording: false, ownerTabId: null, pendingNote: null });
            return steps;
        },

        cancel: (ownerTabId) => {
            const state = get();
            if (!state.isRecording || state.ownerTabId !== ownerTabId) return false;
            set({
                isRecording: false,
                ownerTabId: null,
                draftSteps: [],
                pendingNote: null,
            });
            return true;
        },

        setTabActive: (tabId, active) => {
            if (!tabId) return;
            if (active) {
                if (get().activeTabId !== tabId) set({ activeTabId: tabId });
                return;
            }
            if (get().activeTabId === tabId) set({ activeTabId: null });
        },

        isRecordingFor: (tabId) => {
            const state = get();
            return state.isRecording && state.ownerTabId === tabId;
        },

        noteOperation: (opId, params, extras, ownerTabId) => (
            createPending(opId, params ?? {}, false, extras, ownerTabId)
        ),

        noteNonRecordable: (opId, extras, ownerTabId) => (
            createPending(opId, {}, true, extras, ownerTabId)
        ),

        pendingTicketFor: (tabId) => {
            const state = get();
            if (!state.isRecording || state.ownerTabId !== tabId) return null;
            return state.pendingNote?.ticket ?? null;
        },

        canCommitWorkingFile: (tabId, ticket) => {
            const state = get();
            if (!ticket) {
                // Tab khác vẫn được làm việc độc lập khi một tab đang ghi.
                return !(state.isRecording && state.ownerTabId === tabId);
            }
            return state.isRecording
                && state.ownerTabId === tabId
                && ticket.ownerTabId === tabId
                && state.sessionId === ticket.sessionId
                && sameTicket(state.pendingNote?.ticket, ticket);
        },

        noteCommit: (ticket, extras) => {
            const state = get();
            const pending = state.pendingNote;
            if (
                !state.isRecording
                || !pending
                || !ticket
                || state.ownerTabId !== ticket.ownerTabId
                || state.sessionId !== ticket.sessionId
                || !sameTicket(pending.ticket, ticket)
            ) {
                return false;
            }

            const mergedExtras: RecorderExtras = { ...pending.extras, ...extras };
            const step = buildRecipeStep(pending.opId, pending.params, mergedExtras);
            const finalStep: RecipeStep = pending.forceNonRecordable && step.recordable
                ? { ...step, recordable: false }
                : step;
            set({ draftSteps: [...state.draftSteps, finalStep], pendingNote: null });
            return true;
        },

        discardPending: (ticket) => {
            const state = get();
            const pending = state.pendingNote;
            if (!state.isRecording || !pending || ticket === null) return false;

            const canDiscard = ticket !== undefined && sameTicket(pending.ticket, ticket);
            if (!canDiscard) return false;

            set({ pendingNote: null });
            return true;
        },
    };
});

// ──────────────────────────── Convenience API ────────────────────────────

export const recipeRecorder = {
    get state() { return recipeRecorderStore.getState(); },
    get isRecording() { return recipeRecorderStore.getState().isRecording; },
    get ownerTabId() { return recipeRecorderStore.getState().ownerTabId; },
    get draftSteps() { return recipeRecorderStore.getState().draftSteps; },
    start: (ownerTabId: string) => recipeRecorderStore.getState().start(ownerTabId),
    stop: (ownerTabId: string) => recipeRecorderStore.getState().stop(ownerTabId),
    cancel: (ownerTabId: string) => recipeRecorderStore.getState().cancel(ownerTabId),
    setTabActive: (tabId: string, active: boolean) => (
        recipeRecorderStore.getState().setTabActive(tabId, active)
    ),
    isRecordingFor: (tabId: string) => recipeRecorderStore.getState().isRecordingFor(tabId),
    noteOperation: (
        opId: RecipeOpId,
        params: Record<string, unknown>,
        extras?: RecorderExtras,
        ownerTabId?: string,
    ) => recipeRecorderStore.getState().noteOperation(opId, params, extras, ownerTabId),
    noteNonRecordable: (
        opId: RecipeOpId,
        extras?: RecorderExtras,
        ownerTabId?: string,
    ) => recipeRecorderStore.getState().noteNonRecordable(opId, extras, ownerTabId),
    pendingTicketFor: (tabId: string) => recipeRecorderStore.getState().pendingTicketFor(tabId),
    canCommitWorkingFile: (tabId: string, ticket?: RecipeOperationTicket | null) => (
        recipeRecorderStore.getState().canCommitWorkingFile(tabId, ticket)
    ),
    noteCommit: (ticket: RecipeOperationTicket | null, extras?: RecorderExtras) => (
        recipeRecorderStore.getState().noteCommit(ticket, extras)
    ),
    discardPending: (ticket?: RecipeOperationTicket | null) => (
        recipeRecorderStore.getState().discardPending(ticket)
    ),
};

/** Hook subscribe selector tới recorder store. */
export function useRecipeRecorder<T>(selector: (state: RecipeRecorderState) => T): T {
    return useStore(recipeRecorderStore, selector);
}

/** Kiểm tra nhanh opId có metadata hay không. */
export function isKnownRecipeOp(opId: string): opId is RecipeOpId {
    return Object.prototype.hasOwnProperty.call(RECIPE_OP_META, opId);
}
