import type { StickerDetectionStrategy } from '../../lib/stickerSheetApi';
import type { StickerOutputStorage } from './stickerOutputSettings';

const DETECTION_STORAGE_KEY = 'ps_sticker_unified_detection_v2';
const LEGACY_REMOVE_WHITE_BG_KEY = 'ps_sticker_removeWhiteBg';

function resolveStorage(storage?: StickerOutputStorage | null): StickerOutputStorage | null {
    if (storage !== undefined) return storage;
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
        return null;
    }
}

/** UIUX (audit 2026-09-06 §BACKGROUND.1): giữ lựa chọn nền đã lưu ở luồng cũ. */
export function loadStickerRemoveWhiteBg(storage?: StickerOutputStorage | null): boolean {
    const resolved = resolveStorage(storage);
    try {
        const saved = JSON.parse(resolved?.getItem(DETECTION_STORAGE_KEY) ?? 'null') as unknown;
        if (saved && typeof saved === 'object' && 'removeWhiteBg' in saved
            && typeof saved.removeWhiteBg === 'boolean') return saved.removeWhiteBg;
    } catch { /* Khóa mới hỏng: còn có thể phục hồi lựa chọn từ bản cũ. */ }
    try {
        const legacy = JSON.parse(resolved?.getItem(LEGACY_REMOVE_WHITE_BG_KEY) ?? 'null') as unknown;
        if (typeof legacy === 'boolean') return legacy;
    } catch { /* Không có lựa chọn hợp lệ: dùng mặc định tương thích StickerTool. */ }
    return true;
}

export function saveStickerRemoveWhiteBg(value: boolean, storage?: StickerOutputStorage | null): void {
    try {
        resolveStorage(storage)?.setItem(DETECTION_STORAGE_KEY, JSON.stringify({ removeWhiteBg: value }));
    } catch { /* Storage bị chặn không được làm gián đoạn nhận diện. */ }
}

/** Tùy chọn nền quyết định mask nguồn, không phải tham số vị trí dao/bù xén. */
export function resolveStickerDetectionStrategy(
    cutMode: string,
    removeWhiteBg: boolean,
    preferred: StickerDetectionStrategy = 'auto',
): StickerDetectionStrategy {
    if (cutMode === 'alpha') return 'alpha';
    if (!removeWhiteBg) return 'page-box';
    return preferred === 'page-box' ? 'auto' : preferred;
}
