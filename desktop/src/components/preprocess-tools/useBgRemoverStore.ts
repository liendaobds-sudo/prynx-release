import { BgRemoverOptionsState } from './BgRemoverOptions';
import { createImageBatchStore, type BatchItem, type BatchTabState } from './imageBatch/store';

// Store tách nền = store-lô-ảnh dùng chung với options riêng của tách nền.
// Giữ nguyên tên export cũ (useBgRemoverStore, defaultTabState, BatchItem, TabState)
// để phần còn lại của code không phải đổi import.

export type { BatchItem };
export type TabState = BatchTabState<BgRemoverOptionsState>;

const DEFAULT_OPTIONS: BgRemoverOptionsState = {
    aiEngine: 'general', edgeShift: 0, bgColor: 'transparent', customHex: '#FFFFFF', autoCrop: false,
};

export const defaultTabState: TabState = {
    batchItems: [],
    selectedId: null,
    options: { ...DEFAULT_OPTIONS },
    isProcessing: false,
    progress: '',
    error: '',
};

export const useBgRemoverStore = createImageBatchStore<BgRemoverOptionsState>(DEFAULT_OPTIONS);
