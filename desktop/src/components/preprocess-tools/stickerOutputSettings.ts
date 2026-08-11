import { DEFAULT_CROP_TO_STICKER } from './stickerToolPolicy';

export type StickerCutMode = 'original' | 'alpha' | 'bleed' | 'none';
export type StickerCornerStyle = 'preserve' | 'round' | 'miter';
export type StickerBleedColorType = 'image' | 'trajectory' | 'inpaint' | 'solid';
export type StickerSolidBleedCmyk = readonly [number, number, number, number];

export interface StickerOutputSettings {
    cutMode: StickerCutMode;
    offsetMm: number;
    cornerStyle: StickerCornerStyle;
    fillHoles: boolean;
    bleedMm: number;
    bleedColorType: StickerBleedColorType;
    solidBleedCmyk: StickerSolidBleedCmyk;
    cropToSticker: boolean;
}

export interface StickerOutputStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const STORAGE_PREFIX = 'ps_sticker_';
const CUT_MODES: readonly StickerCutMode[] = ['original', 'alpha', 'bleed', 'none'];
const CORNER_STYLES: readonly StickerCornerStyle[] = ['preserve', 'round', 'miter'];
const BLEED_COLOR_TYPES: readonly StickerBleedColorType[] = ['image', 'trajectory', 'inpaint', 'solid'];

export const DEFAULT_STICKER_OUTPUT_SETTINGS: Readonly<StickerOutputSettings> = Object.freeze({
    cutMode: 'original',
    offsetMm: 0,
    cornerStyle: 'preserve',
    fillHoles: true,
    bleedMm: 0,
    bleedColorType: 'image',
    solidBleedCmyk: Object.freeze([0, 0, 0, 0]) as StickerSolidBleedCmyk,
    cropToSticker: DEFAULT_CROP_TO_STICKER,
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return clamp(value, min, max);
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function sanitizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function roundColorChannel(value: number): number {
    const rounded = Math.round(clamp(value, 0, 100) * 100) / 100;
    return Object.is(rounded, -0) ? 0 : rounded;
}

function rgbHexToCmyk(value: string): StickerSolidBleedCmyk | null {
    const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
    if (!match) return null;

    const rgb = match[1];
    const red = Number.parseInt(rgb.slice(0, 2), 16) / 255;
    const green = Number.parseInt(rgb.slice(2, 4), 16) / 255;
    const blue = Number.parseInt(rgb.slice(4, 6), 16) / 255;
    const black = 1 - Math.max(red, green, blue);

    if (black >= 1) return [0, 0, 0, 100];

    const denominator = 1 - black;
    return [
        roundColorChannel(((1 - red - black) / denominator) * 100),
        roundColorChannel(((1 - green - black) / denominator) * 100),
        roundColorChannel(((1 - blue - black) / denominator) * 100),
        roundColorChannel(black * 100),
    ];
}

function parseCmykString(value: string): StickerSolidBleedCmyk | null {
    const parts = value.split(',').map(part => part.trim());
    if (parts.length !== 4 || parts.some(part => part.length === 0)) return null;

    const channels = parts.map(Number);
    if (channels.some(channel => !Number.isFinite(channel))) return null;
    return channels.map(channel => roundColorChannel(channel)) as unknown as StickerSolidBleedCmyk;
}

function sanitizeSolidBleedCmyk(value: unknown): StickerSolidBleedCmyk {
    if (typeof value === 'string') {
        const parsed = rgbHexToCmyk(value) ?? parseCmykString(value);
        if (parsed) return parsed;
    }

    if (Array.isArray(value) && value.length === 4) {
        const channels = value.map(channel => typeof channel === 'number' ? channel : Number.NaN);
        if (channels.every(Number.isFinite)) {
            return channels.map(channel => roundColorChannel(channel)) as unknown as StickerSolidBleedCmyk;
        }
    }

    return [...DEFAULT_STICKER_OUTPUT_SETTINGS.solidBleedCmyk] as StickerSolidBleedCmyk;
}

/** Chuẩn hóa mọi đầu vào trước khi gửi thiết lập xuống luồng tạo đường bế. */
export function sanitizeStickerOutputSettings(value: unknown): StickerOutputSettings {
    const source = isRecord(value) ? value : {};
    return {
        cutMode: sanitizeEnum(source.cutMode, CUT_MODES, DEFAULT_STICKER_OUTPUT_SETTINGS.cutMode),
        offsetMm: sanitizeNumber(source.offsetMm, DEFAULT_STICKER_OUTPUT_SETTINGS.offsetMm, -10, 10),
        cornerStyle: sanitizeEnum(
            source.cornerStyle,
            CORNER_STYLES,
            DEFAULT_STICKER_OUTPUT_SETTINGS.cornerStyle,
        ),
        fillHoles: sanitizeBoolean(source.fillHoles, DEFAULT_STICKER_OUTPUT_SETTINGS.fillHoles),
        bleedMm: sanitizeNumber(source.bleedMm, DEFAULT_STICKER_OUTPUT_SETTINGS.bleedMm, 0, 10),
        bleedColorType: sanitizeEnum(
            source.bleedColorType,
            BLEED_COLOR_TYPES,
            DEFAULT_STICKER_OUTPUT_SETTINGS.bleedColorType,
        ),
        solidBleedCmyk: sanitizeSolidBleedCmyk(source.solidBleedCmyk ?? source.bleedColorHex),
        cropToSticker: sanitizeBoolean(
            source.cropToSticker,
            DEFAULT_STICKER_OUTPUT_SETTINGS.cropToSticker,
        ),
    };
}

function resolveStorage(storage: StickerOutputStorage | null | undefined): StickerOutputStorage | null {
    if (storage !== undefined) return storage;
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function readLegacyValue(storage: StickerOutputStorage, key: string): unknown {
    let raw: string | null;
    try {
        raw = storage.getItem(`${STORAGE_PREFIX}${key}`);
    } catch {
        return undefined;
    }
    if (raw === null) return undefined;

    try {
        return JSON.parse(raw) as unknown;
    } catch {
        // Một số build cũ đã ghi trực tiếp chuỗi màu thay vì JSON.stringify.
        return raw;
    }
}

/** Đọc các khóa tương thích với StickerTool cũ; localStorage hỏng/bị chặn luôn trả mặc định an toàn. */
export function loadStickerOutputSettings(
    storage?: StickerOutputStorage | null,
): StickerOutputSettings {
    const resolvedStorage = resolveStorage(storage);
    if (!resolvedStorage) return sanitizeStickerOutputSettings(undefined);

    return sanitizeStickerOutputSettings({
        cutMode: readLegacyValue(resolvedStorage, 'cutMode'),
        offsetMm: readLegacyValue(resolvedStorage, 'offsetMm'),
        cornerStyle: readLegacyValue(resolvedStorage, 'cornerStyle'),
        fillHoles: readLegacyValue(resolvedStorage, 'fillHoles'),
        bleedMm: readLegacyValue(resolvedStorage, 'bleedMm'),
        bleedColorType: readLegacyValue(resolvedStorage, 'bleedColorType'),
        bleedColorHex: readLegacyValue(resolvedStorage, 'bleedColorHex'),
        cropToSticker: readLegacyValue(resolvedStorage, 'cropToSticker'),
    });
}

function writeLegacyValue(storage: StickerOutputStorage, key: string, value: unknown): void {
    try {
        storage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
    } catch {
        // Không làm gián đoạn tác vụ nếu trình duyệt chặn hoặc hết dung lượng localStorage.
    }
}

/** Lưu thiết lập đã chuẩn hóa và ghi ngược các khóa mà StickerTool cũ đang dùng. */
export function saveStickerOutputSettings(
    value: unknown,
    storage?: StickerOutputStorage | null,
): StickerOutputSettings {
    const settings = sanitizeStickerOutputSettings(value);
    const resolvedStorage = resolveStorage(storage);
    if (!resolvedStorage) return settings;

    writeLegacyValue(resolvedStorage, 'cutMode', settings.cutMode);
    writeLegacyValue(resolvedStorage, 'offsetMm', settings.offsetMm);
    writeLegacyValue(resolvedStorage, 'cornerStyle', settings.cornerStyle);
    writeLegacyValue(resolvedStorage, 'fillHoles', settings.fillHoles);
    writeLegacyValue(resolvedStorage, 'bleedMm', settings.bleedMm);
    writeLegacyValue(resolvedStorage, 'bleedColorType', settings.bleedColorType);
    writeLegacyValue(resolvedStorage, 'bleedColorHex', settings.solidBleedCmyk.join(','));
    writeLegacyValue(resolvedStorage, 'cropToSticker', settings.cropToSticker);

    return settings;
}
