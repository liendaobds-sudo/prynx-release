import { createImageBatchStore, type BatchTabState } from './imageBatch/store';

export interface UpscaleOptionsState {
    scaleFactor: 2 | 4;
    model: 'quality' | 'balanced' | 'general';
}

const DEFAULT_UPSCALE_OPTIONS: UpscaleOptionsState = {
    scaleFactor: 4,
    // PERF (audit 2026-07-29 §NET.01): mặc định giữ tốc độ của model nhẹ nhưng có
    // bù chi tiết; chế độ Chất lượng nặng và cần GPU nên chỉ chạy khi chủ động chọn.
    model: 'balanced',
};

export const defaultUpscaleTabState: BatchTabState<UpscaleOptionsState> = {
    batchItems: [], selectedId: null, options: { ...DEFAULT_UPSCALE_OPTIONS },
    isProcessing: false, progress: '', error: '',
};

export const useUpscaleStore = createImageBatchStore<UpscaleOptionsState>(DEFAULT_UPSCALE_OPTIONS);
