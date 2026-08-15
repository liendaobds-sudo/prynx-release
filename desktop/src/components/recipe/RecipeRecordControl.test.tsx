// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    toastInfo: vi.fn(),
}));

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../ui/Toast', () => ({
    toast: { info: mocks.toastInfo, error: vi.fn(), success: vi.fn() },
}));
vi.mock('../../lib/recipe/recipeStore', () => ({ saveRecipe: vi.fn() }));

import { recipeRecorder, recipeRecorderStore } from '../../lib/recipe/RecipeRecorder';
import RecipeRecordControl from './RecipeRecordControl';

beforeEach(() => {
    vi.clearAllMocks();
    recipeRecorderStore.setState({
        isRecording: false,
        ownerTabId: null,
        activeTabId: null,
        sessionId: 0,
        draftSteps: [],
        pendingNote: null,
    });
});

describe('RecipeRecordControl — quyền sở hữu tab', () => {
    it('tab khác bị khóa và không thể dừng phiên đang ghi', () => {
        recipeRecorder.start('tab-a');

        render(
            <RecipeRecordControl
                tabId="tab-b"
                onOpenPanel={vi.fn()}
                sourcePageCount={2}
            />,
        );

        const button = screen.getByRole('button', {
            name: 'recipe.recipeRecordControl:ghi_quy_trinh',
        });
        expect((button as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(button);
        expect(recipeRecorder.isRecordingFor('tab-a')).toBe(true);
        expect(recipeRecorder.ownerTabId).toBe('tab-a');
    });

    it('chỉ tab sở hữu mới dừng được phiên của chính nó', () => {
        recipeRecorder.start('tab-a');

        render(
            <RecipeRecordControl
                tabId="tab-a"
                onOpenPanel={vi.fn()}
                sourcePageCount={2}
            />,
        );

        fireEvent.click(screen.getByRole('button', {
            name: 'recipe.recipeRecordControl:dung_ghi_quy_trinh',
        }));
        expect(recipeRecorder.isRecording).toBe(false);
        expect(mocks.toastInfo).toHaveBeenCalledWith(
            'recipe.recipeRecordControl:chua_ghi_duoc_buoc_nao_da_huy_phien_ghi',
        );
    });

    it('không thể bắt đầu ghi khi tab đang phát quy trình', () => {
        render(
            <RecipeRecordControl
                tabId="tab-a"
                onOpenPanel={vi.fn()}
                disabled
            />,
        );

        const button = screen.getByRole('button', {
            name: 'recipe.recipeRecordControl:ghi_quy_trinh',
        });
        expect((button as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(button);
        expect(recipeRecorder.isRecording).toBe(false);
    });
});
