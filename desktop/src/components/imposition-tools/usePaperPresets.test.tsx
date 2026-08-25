// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedForm } from './paperUtils';
import { usePaperPresets } from './usePaperPresets';

const STORAGE_KEY = 'test_paper_presets';

const SAVED_FORM: SavedForm = {
    id: 'custom_existing',
    name: 'Khổ đã lưu',
    w: 320,
    h: 430,
    marginTop: 5,
    marginBottom: 6,
    marginLeft: 7,
    marginRight: 8,
    marginMode: 'include_marks',
    classification: 'offset',
    usages: ['offset', 'nup'],
    gripperMargin: 10,
};

describe('usePaperPresets', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('nạp, thêm, xóa và persist preset theo storage key hiện tại', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([SAVED_FORM]));
        vi.spyOn(Date, 'now').mockReturnValue(123456);

        const { result } = renderHook(() => usePaperPresets(STORAGE_KEY));

        await waitFor(() => expect(result.current.savedForms).toEqual([SAVED_FORM]));

        let newId = '';
        act(() => {
            newId = result.current.handleSavePreset(
                'Khổ mới', 210, 297, 1, 2, 3, 4,
                'labels_only', 'in_nhanh', 0, ['in_nhanh'],
            );
        });

        expect(newId).toBe('custom_123456');
        expect(result.current.savedForms).toHaveLength(2);
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')).toEqual(result.current.savedForms);

        act(() => result.current.handleDeletePreset(newId));

        expect(result.current.savedForms).toEqual([SAVED_FORM]);
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')).toEqual([SAVED_FORM]);
    });
});
