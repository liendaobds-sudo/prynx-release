import { formatError } from './errorMessages';

export type FileOpeningPhase = 'idle' | 'loading' | 'slow' | 'error';

/** Tab nhận sẵn file kết quả phải hiện trạng thái mở, không hiện uploader rỗng. */
export function initialFileOpeningPhase(initialFile?: File | null): FileOpeningPhase {
    return initialFile ? 'loading' : 'idle';
}

/** FILEIO (audit 2026-08-26 §IMG.B5): giữ nguyên nhân thật thay vì quy mọi ảnh là hỏng. */
export function formatFileOpeningError(error: unknown, fallback: string): string {
    return formatError(error, fallback);
}
