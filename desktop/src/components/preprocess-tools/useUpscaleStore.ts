import { createImageBatchStore, type BatchTabState } from './imageBatch/store';

export interface UpscaleOptionsState {
    scaleFactor: 2 | 4;
    model: 'quality' | 'balanced' | 'general';
}

const DEFAULT_UPSCALE_OPTIONS: UpscaleOptionsState = {
    scaleFactor: 4,
    // PERF (audit 2026-07-28 §UP-13): mặc định giữ tốc độ model nhẹ nhưng bảo
    // toàn texture tốt hơn; RRDBNet nặng chỉ chạy khi người dùng chủ động chọn.
    model: 'balanced',
};

export const defaultUpscaleTabState: BatchTabState<UpscaleOptionsState> = {
    batchItems: [], selectedId: null, options: { ...DEFAULT_UPSCALE_OPTIONS },
    isProcessing: false, progress: '', error: '',
};

export const useUpscaleStore = createImageBatchStore<UpscaleOptionsState>(DEFAULT_UPSCALE_OPTIONS);
