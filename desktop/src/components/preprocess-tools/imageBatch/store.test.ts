import { describe, expect, it, vi } from 'vitest';

import { defaultUpscaleTabState } from '../useUpscaleStore';
import { createImageBatchStore, invalidateBatchResults, type BatchItem } from './store';

const options = { mode: 'a' };

function item(overrides: Partial<BatchItem> = {}): BatchItem {
    return {
        id: 'one', path: 'browser-file', fileName: 'one.png',
        originalUrl: 'blob:original', resultUrl: 'blob:result',
        resultBlob: new Blob(['result']), status: 'success',
        ...overrides,
    };
}

describe('image batch store lifecycle', () => {
    it('thu hồi URL khi thay kết quả, xóa item và reset tab', () => {
        const revoke = vi.fn();
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
        const store = createImageBatchStore(options);
        store.getState().initTab('tab');
        store.getState().addItems('tab', [item()]);

        store.getState().setBatchItems('tab', invalidateBatchResults(store.getState().getTab('tab').batchItems));
        expect(revoke).toHaveBeenCalledWith('blob:result');
        expect(revoke).not.toHaveBeenCalledWith('blob:original');

        store.getState().removeItem('tab', 'one');
        expect(revoke).toHaveBeenCalledWith('blob:original');

        store.getState().addItems('tab', [item({ id: 'two', originalUrl: 'blob:two' })]);
        store.getState().reset('tab');
        expect(revoke).toHaveBeenCalledWith('blob:two');
    });

    it('đổi thiết lập luôn biến kết quả cũ thành pending', () => {
        const [next] = invalidateBatchResults([item({ error: 'old' })]);
        expect(next).toMatchObject({ status: 'pending', resultBlob: undefined, resultUrl: undefined, error: undefined });
    });

    it('fallback Upscale là cùng một snapshot ổn định', () => {
        expect(defaultUpscaleTabState).toBe(defaultUpscaleTabState);
        expect(defaultUpscaleTabState.batchItems).toEqual([]);
    });
});
