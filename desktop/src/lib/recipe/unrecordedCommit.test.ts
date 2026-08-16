import { beforeEach, describe, expect, it } from 'vitest';
import { recipeRecorder, recipeRecorderStore } from './RecipeRecorder';
import { shouldBlockUnrecordedCommit } from './unrecordedCommit';

const TAB_A = 'tab-a';
const TAB_B = 'tab-b';

beforeEach(() => {
    recipeRecorderStore.setState({
        isRecording: false,
        ownerTabId: null,
        draftSteps: [],
        pendingNote: null,
    });
});

describe('shouldBlockUnrecordedCommit — §REC.4', () => {
    it('không ghi thì mọi tool vẫn commit như cũ', () => {
        expect(shouldBlockUnrecordedCommit(TAB_A)).toBe(false);
        expect(shouldBlockUnrecordedCommit(TAB_A, null)).toBe(false);
    });

    it('đang ghi ở tab này mà thao tác không mang vé thì bị chặn', () => {
        recipeRecorder.start(TAB_A);
        expect(shouldBlockUnrecordedCommit(TAB_A)).toBe(true);
        expect(shouldBlockUnrecordedCommit(TAB_A, null)).toBe(true);
    });

    it('tab khác không bị ảnh hưởng bởi phiên ghi của tab đang ghi', () => {
        recipeRecorder.start(TAB_A);
        expect(shouldBlockUnrecordedCommit(TAB_B)).toBe(false);
    });

    it('thao tác đã công bố (có vé) đi tiếp để commitWorkingFile tự kiểm vé', () => {
        recipeRecorder.start(TAB_A);
        const ticket = recipeRecorder.noteOperation('optimize', { preset: 'ebook' }, undefined, TAB_A);
        expect(ticket).not.toBeNull();
        expect(shouldBlockUnrecordedCommit(TAB_A, ticket)).toBe(false);
    });

    it('dừng ghi rồi thì tool cũ commit lại được bình thường', () => {
        recipeRecorder.start(TAB_A);
        expect(shouldBlockUnrecordedCommit(TAB_A)).toBe(true);
        recipeRecorder.stop(TAB_A);
        expect(shouldBlockUnrecordedCommit(TAB_A)).toBe(false);
    });
});
