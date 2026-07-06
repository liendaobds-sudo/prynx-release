import { createImageBatchStore } from './imageBatch/store';

export interface UpscaleOptionsState {
    scaleFactor: 2 | 4;
}

export const useUpscaleStore = createImageBatchStore<UpscaleOptionsState>({
    scaleFactor: 4,
});
