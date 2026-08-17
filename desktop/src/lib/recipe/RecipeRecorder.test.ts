import { beforeEach, describe, expect, it } from 'vitest';
import { isKnownRecipeOp, recipeRecorder, recipeRecorderStore } from './RecipeRecorder';

const TAB_A = 'tab-a';
const TAB_B = 'tab-b';

beforeEach(() => {
    recipeRecorderStore.setState({
        isRecording: false,
        draftSteps: [],
        pendingNote: null,
    });
});

describe('RecipeRecorder — quyền sở hữu phiên ghi', () => {
    it('chỉ một tab được sở hữu phiên ghi và start lần hai không xóa draft', () => {
        expect(recipeRecorder.start(TAB_A)).toBe(true);
        const ticket = recipeRecorder.noteOperation('booklet', { sheetWidth: 320 }, undefined, TAB_A);
        expect(ticket).not.toBeNull();
        expect(recipeRecorder.noteCommit(ticket)).toBe(true);

        expect(recipeRecorder.start(TAB_B)).toBe(false);
        expect(recipeRecorder.ownerTabId).toBe(TAB_A);
        expect(recipeRecorder.draftSteps).toHaveLength(1);
    });

    it('noteOperation + noteCommit ghép đúng thứ tự và không làm lộ ticket vào RecipeStep', () => {
        recipeRecorder.start(TAB_A);
        const first = recipeRecorder.noteOperation(
            'convertcolors',
            { conversions: ['rgb_to_cmyk'] },
            undefined,
            TAB_A,
        );
        expect(recipeRecorder.noteCommit(first)).toBe(true);

        const second = recipeRecorder.noteOperation(
            'booklet',
            { sheetWidth: 320, sheetHeight: 450 },
            undefined,
            TAB_A,
        );
        expect(recipeRecorder.noteCommit(second)).toBe(true);

        const steps = recipeRecorder.stop(TAB_A);
        expect(steps?.map((step) => step.opId)).toEqual(['convertcolors', 'booklet']);
        expect(steps?.[1].label).toContain('320×450mm');
        expect(steps?.[0]).not.toHaveProperty('ticket');
        expect(steps?.[0]).not.toHaveProperty('ownerTabId');
        expect(steps?.[0]).not.toHaveProperty('sessionId');
        expect(steps?.[0]).not.toHaveProperty('operationId');
    });

    it('tab B không thể tạo, xóa hoặc commit pending của tab A', () => {
        recipeRecorder.start(TAB_A);
        const ticketA = recipeRecorder.noteOperation('booklet', {}, undefined, TAB_A);
        expect(ticketA).not.toBeNull();

        recipeRecorder.setTabActive(TAB_B, true);
        expect(recipeRecorder.noteOperation('nup', {}, undefined, TAB_B)).toBeNull();
        expect(recipeRecorder.discardPending()).toBe(false);
        expect(recipeRecorder.noteCommit(ticketA)).toBe(true);
        expect(recipeRecorder.draftSteps.map((step) => step.opId)).toEqual(['booklet']);
    });

    it('pending mới không ghi đè pending cũ chưa commit', () => {
        recipeRecorder.start(TAB_A);
        const first = recipeRecorder.noteOperation('booklet', { sheetWidth: 100 }, undefined, TAB_A);
        const rejected = recipeRecorder.noteOperation(
            'nup',
            { sheetWidth: 200, sheetHeight: 300 },
            undefined,
            TAB_A,
        );

        expect(first).not.toBeNull();
        expect(rejected).toBeNull();
        expect(recipeRecorder.noteCommit(first)).toBe(true);
        expect(recipeRecorder.draftSteps.map((step) => step.opId)).toEqual(['booklet']);
    });

    it('ticket thao tác cũ không thể commit hoặc xóa pending mới', () => {
        recipeRecorder.start(TAB_A);
        const oldTicket = recipeRecorder.noteOperation('booklet', {}, undefined, TAB_A);
        expect(recipeRecorder.discardPending(oldTicket)).toBe(true);

        const currentTicket = recipeRecorder.noteOperation('nup', {}, undefined, TAB_A);
        expect(recipeRecorder.noteCommit(oldTicket)).toBe(false);
        expect(recipeRecorder.discardPending(oldTicket)).toBe(false);
        expect(recipeRecorder.noteCommit(currentTicket)).toBe(true);
        expect(recipeRecorder.draftSteps.map((step) => step.opId)).toEqual(['nup']);
    });

    it('ticket của phiên cũ không thể ảnh hưởng phiên mới', () => {
        recipeRecorder.start(TAB_A);
        const oldTicket = recipeRecorder.noteOperation('booklet', {}, undefined, TAB_A);
        expect(recipeRecorder.cancel(TAB_A)).toBe(true);

        recipeRecorder.start(TAB_A);
        const currentTicket = recipeRecorder.noteOperation('shuffle', {}, undefined, TAB_A);
        expect(recipeRecorder.noteCommit(oldTicket)).toBe(false);
        expect(recipeRecorder.discardPending(oldTicket)).toBe(false);
        expect(recipeRecorder.noteCommit(currentTicket)).toBe(true);
        expect(recipeRecorder.draftSteps.map((step) => step.opId)).toEqual(['shuffle']);
    });

    it('tab không sở hữu không thể stop hoặc cancel phiên của tab khác', () => {
        recipeRecorder.start(TAB_A);
        expect(recipeRecorder.stop(TAB_B)).toBeNull();
        expect(recipeRecorder.cancel(TAB_B)).toBe(false);
        expect(recipeRecorder.isRecordingFor(TAB_A)).toBe(true);
    });

    it('ticket null từ Catalog/playback không tiêu thụ pending thật', () => {
        recipeRecorder.start(TAB_A);
        const ticket = recipeRecorder.noteOperation('booklet', {}, undefined, TAB_A);
        expect(recipeRecorder.noteCommit(null)).toBe(false);
        expect(recipeRecorder.discardPending(null)).toBe(false);
        expect(recipeRecorder.noteCommit(ticket)).toBe(true);
        expect(recipeRecorder.draftSteps).toHaveLength(1);
    });

    it('chỉ cho commit bằng đúng ticket của pending hiện tại', () => {
        recipeRecorder.start(TAB_A);
        const ticket = recipeRecorder.noteOperation('booklet', {}, undefined, TAB_A);

        expect(recipeRecorder.canCommitWorkingFile(TAB_A, ticket)).toBe(true);
        expect(recipeRecorder.canCommitWorkingFile(TAB_A, null)).toBe(false);
        expect(recipeRecorder.canCommitWorkingFile(TAB_B, null)).toBe(true);
        expect(recipeRecorder.canCommitWorkingFile(TAB_B, ticket)).toBe(false);
    });

    it('từ chối kết quả về muộn từ phiên đã dừng hoặc đã hủy', () => {
        recipeRecorder.start(TAB_A);
        const stoppedTicket = recipeRecorder.noteOperation('booklet', {}, undefined, TAB_A);
        expect(recipeRecorder.stop(TAB_A)).not.toBeNull();
        expect(recipeRecorder.canCommitWorkingFile(TAB_A, stoppedTicket)).toBe(false);

        recipeRecorder.start(TAB_A);
        const canceledTicket = recipeRecorder.noteOperation('nup', {}, undefined, TAB_A);
        expect(recipeRecorder.cancel(TAB_A)).toBe(true);
        expect(recipeRecorder.canCommitWorkingFile(TAB_A, canceledTicket)).toBe(false);
        expect(recipeRecorder.canCommitWorkingFile(TAB_A, null)).toBe(true);
    });
});

describe('RecipeRecorder — vòng đời và dữ liệu Step', () => {
    it('note khi không ghi không tạo pending', () => {
        recipeRecorder.setTabActive(TAB_A, true);
        expect(recipeRecorder.noteOperation('booklet', {}, undefined, TAB_A)).toBeNull();
        expect(recipeRecorder.state.pendingNote).toBeNull();
    });

    it('noteNonRecordable tạo Step recordable=false', () => {
        recipeRecorder.start(TAB_A);
        const ticket = recipeRecorder.noteNonRecordable('crop', undefined, TAB_A);
        expect(recipeRecorder.noteCommit(ticket)).toBe(true);
        const steps = recipeRecorder.stop(TAB_A);
        expect(steps).toHaveLength(1);
        expect(steps?.[0].opId).toBe('crop');
        expect(steps?.[0].recordable).toBe(false);
    });

    it('commit thừa sau khi đã chốt không nhân đôi Step', () => {
        recipeRecorder.start(TAB_A);
        const ticket = recipeRecorder.noteOperation('shuffle', { specialAction: 'reverse' }, undefined, TAB_A);
        expect(recipeRecorder.noteCommit(ticket)).toBe(true);
        expect(recipeRecorder.noteCommit(ticket)).toBe(false);
        expect(recipeRecorder.draftSteps).toHaveLength(1);
    });

    it('cancel của chủ sở hữu vứt bỏ draft và tắt ghi', () => {
        recipeRecorder.start(TAB_A);
        const ticket = recipeRecorder.noteOperation('booklet', {}, undefined, TAB_A);
        recipeRecorder.noteCommit(ticket);
        expect(recipeRecorder.cancel(TAB_A)).toBe(true);
        expect(recipeRecorder.isRecording).toBe(false);
        expect(recipeRecorder.draftSteps).toHaveLength(0);
    });

    it('extras viewerPageOrder được chụp vào Step', () => {
        recipeRecorder.start(TAB_A);
        const ticket = recipeRecorder.noteOperation('booklet', { sheetWidth: 320 }, undefined, TAB_A);
        recipeRecorder.noteCommit(ticket, { viewerPageOrder: [1, 2, 3, -1] });
        const steps = recipeRecorder.stop(TAB_A);
        expect(steps?.[0].viewerPageOrder).toEqual([1, 2, 3, -1]);
    });

    // RECIPE (audit 2026-08-17 §REC.5): Undo rút Step đã ghi.
    it('rollbackDraftTo rút draft về đúng độ dài khi Undo', () => {
        recipeRecorder.start(TAB_A);
        const t1 = recipeRecorder.noteOperation('nup', { cols: 2 }, undefined, TAB_A);
        recipeRecorder.noteCommit(t1);
        const t2 = recipeRecorder.noteOperation('optimize', { preset: 'ebook' }, undefined, TAB_A);
        recipeRecorder.noteCommit(t2);
        expect(recipeRecorder.draftSteps).toHaveLength(2);
        // Undo commit thứ 2 → rút về 1 Step.
        expect(recipeRecorder.rollbackDraftTo(TAB_A, 1)).toBe(true);
        expect(recipeRecorder.draftSteps).toHaveLength(1);
        // Tab khác hoặc length không hợp lệ → no-op.
        expect(recipeRecorder.rollbackDraftTo(TAB_B, 0)).toBe(false);
        expect(recipeRecorder.rollbackDraftTo(TAB_A, 5)).toBe(false);
        expect(recipeRecorder.rollbackDraftTo(TAB_A, 1)).toBe(false); // length===current
        recipeRecorder.cancel(TAB_A);
    });
});

describe('isKnownRecipeOp', () => {
    it('nhận diện opId hợp lệ và không hợp lệ', () => {
        expect(isKnownRecipeOp('booklet')).toBe(true);
        expect(isKnownRecipeOp('convertcolors')).toBe(true);
        expect(isKnownRecipeOp('khong_ton_tai')).toBe(false);
    });
});
