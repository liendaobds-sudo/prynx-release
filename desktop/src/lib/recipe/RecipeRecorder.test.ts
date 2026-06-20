import { describe, it, expect, beforeEach } from 'vitest';
import { recipeRecorder, recipeRecorderStore, isKnownRecipeOp } from './RecipeRecorder';

beforeEach(() => {
    // Reset store về trạng thái sạch trước mỗi test.
    recipeRecorderStore.setState({ isRecording: false, draftSteps: [], pendingNote: null });
});

describe('RecipeRecorder — vòng đời ghi', () => {
    it('start bật ghi và xóa draft cũ', () => {
        recipeRecorderStore.setState({ draftSteps: [{ opId: 'booklet', label: 'x', params: {}, recordable: true }] });
        recipeRecorder.start();
        expect(recipeRecorder.isRecording).toBe(true);
        expect(recipeRecorder.draftSteps).toHaveLength(0);
    });

    it('noteOperation + noteCommit ghép thành 1 Step đúng thứ tự', () => {
        recipeRecorder.start();
        recipeRecorder.noteOperation('convertcolors', { conversions: ['rgb_to_cmyk'] });
        recipeRecorder.noteCommit();
        recipeRecorder.noteOperation('booklet', { sheetWidth: 320, sheetHeight: 450 });
        recipeRecorder.noteCommit();
        const steps = recipeRecorder.stop();
        expect(steps.map(s => s.opId)).toEqual(['convertcolors', 'booklet']);
        expect(steps[0].recordable).toBe(true);
        expect(steps[1].label).toContain('320×450mm');
    });

    it('commit không có note đi trước → bỏ qua (không tạo Step)', () => {
        recipeRecorder.start();
        recipeRecorder.noteCommit(); // không có pending
        expect(recipeRecorder.draftSteps).toHaveLength(0);
    });

    it('note khi KHÔNG ghi → không tạo pending', () => {
        recipeRecorder.noteOperation('booklet', {});
        recipeRecorder.start();
        recipeRecorder.noteCommit();
        expect(recipeRecorder.draftSteps).toHaveLength(0);
    });

    it('noteNonRecordable → Step recordable=false', () => {
        recipeRecorder.start();
        recipeRecorder.noteNonRecordable('crop');
        recipeRecorder.noteCommit();
        const steps = recipeRecorder.stop();
        expect(steps).toHaveLength(1);
        expect(steps[0].opId).toBe('crop');
        expect(steps[0].recordable).toBe(false);
    });

    it('note mới ghi đè note cũ chưa commit (last-wins)', () => {
        recipeRecorder.start();
        recipeRecorder.noteOperation('booklet', { sheetWidth: 100 });
        recipeRecorder.noteOperation('nup', { sheetWidth: 200, sheetHeight: 300 });
        recipeRecorder.noteCommit();
        const steps = recipeRecorder.stop();
        expect(steps).toHaveLength(1);
        expect(steps[0].opId).toBe('nup');
    });

    it('commit thừa (sau khi đã chốt) không nhân đôi Step', () => {
        recipeRecorder.start();
        recipeRecorder.noteOperation('shuffle', { specialAction: 'reverse' });
        recipeRecorder.noteCommit();
        recipeRecorder.noteCommit(); // commit thừa
        expect(recipeRecorder.draftSteps).toHaveLength(1);
    });

    it('cancel vứt bỏ draft và tắt ghi', () => {
        recipeRecorder.start();
        recipeRecorder.noteOperation('booklet', {});
        recipeRecorder.noteCommit();
        recipeRecorder.cancel();
        expect(recipeRecorder.isRecording).toBe(false);
        expect(recipeRecorder.draftSteps).toHaveLength(0);
    });

    it('extras (viewerPageOrder) được chụp vào Step', () => {
        recipeRecorder.start();
        recipeRecorder.noteOperation('booklet', { sheetWidth: 320, sheetHeight: 450 });
        recipeRecorder.noteCommit({ viewerPageOrder: [1, 2, 3, -1] });
        const steps = recipeRecorder.stop();
        expect(steps[0].viewerPageOrder).toEqual([1, 2, 3, -1]);
    });

    it('discardPending bỏ note → commit kế tiếp không tạo Step', () => {
        recipeRecorder.start();
        recipeRecorder.noteOperation('booklet', {});
        recipeRecorder.discardPending();
        recipeRecorder.noteCommit();
        expect(recipeRecorder.draftSteps).toHaveLength(0);
    });
});

describe('isKnownRecipeOp', () => {
    it('nhận diện opId hợp lệ / không hợp lệ', () => {
        expect(isKnownRecipeOp('booklet')).toBe(true);
        expect(isKnownRecipeOp('convertcolors')).toBe(true);
        expect(isKnownRecipeOp('khong_ton_tai')).toBe(false);
    });
});
