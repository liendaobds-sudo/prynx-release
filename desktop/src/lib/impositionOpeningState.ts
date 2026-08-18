export type FileOpeningPhase = 'idle' | 'loading' | 'slow' | 'error';

/** Tab nhận sẵn file kết quả phải hiện trạng thái mở, không hiện uploader rỗng. */
export function initialFileOpeningPhase(initialFile?: File | null): FileOpeningPhase {
    return initialFile ? 'loading' : 'idle';
}
