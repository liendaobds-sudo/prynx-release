const PPE_NATIVE_UNSUPPORTED_PREFIX = 'PPE_NATIVE_UNSUPPORTED:';

export interface PpeUnsupportedStatus {
    reason: string;
    detail: string;
    fallbackFontSha256?: string | null;
}

// COLOR (audit 2026-09-28 §K.THUMB): cùng enum capability của worker. Lỗi hủy,
// I/O, thiếu RAM hoặc transport không được đổi thành quyết định xem tương thích.
const PPE_UNSUPPORTED_REASONS = new Set([
    'image_codec', 'knockout_transparency', 'unsupported_transparency',
    'color_approximation', 'geometry_approximation', 'hidden_content', 'unsupported_feature',
]);

export function isRecognizedPpeUnsupportedStatus(
    status: PpeUnsupportedStatus | null,
): status is PpeUnsupportedStatus {
    return status !== null && PPE_UNSUPPORTED_REASONS.has(status.reason);
}

export function parsePpeUnsupportedStatus(error: unknown): PpeUnsupportedStatus | null {
    if (error instanceof Error && ['AbortError', 'CancelledTileRenderError', 'SupersededTileRenderError'].includes(error.name)) {
        return null;
    }
    const message = (error instanceof Error ? error.message : String(error)).trimStart();
    if (!message.startsWith(PPE_NATIVE_UNSUPPORTED_PREFIX)) return null;
    try {
        const raw = JSON.parse(message.slice(PPE_NATIVE_UNSUPPORTED_PREFIX.length));
        if (!raw || typeof raw.reason !== 'string' || typeof raw.detail !== 'string') return null;
        return {
            reason: raw.reason,
            detail: raw.detail,
            fallbackFontSha256: typeof raw.fallbackFontSha256 === 'string'
                ? raw.fallbackFontSha256
                : null,
        };
    } catch {
        return null;
    }
}
