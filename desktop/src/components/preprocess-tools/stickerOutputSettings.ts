import { DEFAULT_CROP_TO_STICKER } from './stickerToolPolicy';

export type StickerCutMode = 'original' | 'alpha' | 'bleed' | 'none';
export type StickerCornerStyle = 'preserve' | 'round' | 'miter';
export type StickerBleedColorType = 'image' | 'trajectory' | 'inpaint' | 'solid';
export type StickerSolidBleedCmyk = readonly [number, number, number, number];
export type StickerThruCutShape = 'rounded_rect' | 'ellipse' | 'contour_offset';

export interface StickerOutputSettings {
    cutMode: StickerCutMode;
    offsetMm: number;
    cornerStyle: StickerCornerStyle;
    fillHoles: boolean;
    bleedMm: number;
    bleedColorType: StickerBleedColorType;
    solidBleedCmyk: StickerSolidBleedCmyk;
    cropToSticker: boolean;
    /** Dao đứt ngoài; mặc định tắt để giữ nguyên hành vi cũ. */
    thrucutEnabled: boolean;
    thrucutShape: StickerThruCutShape;
    thrucutMarginMm: number;
    thrucutMarginLinked: boolean;
    thrucutMarginTopMm: number;
    thrucutMarginBottomMm: number;
    thrucutMarginLeftMm: number;
    thrucutMarginRightMm: number;
    thrucutRadiusMm: number;
    thrucutSpotName: string;
    thrucutColorHex: string;
    thrucutColorCmyk: StickerSolidBleedCmyk;
}

export interface StickerOutputStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const STORAGE_PREFIX = 'ps_sticker_';
const CUT_MODES: readonly StickerCutMode[] = ['original', 'alpha', 'bleed', 'none'];
const CORNER_STYLES: readonly StickerCornerStyle[] = ['preserve', 'round', 'miter'];
const BLEED_COLOR_TYPES: readonly StickerBleedColorType[] = ['image', 'trajectory', 'inpaint', 'solid'];
const THRUCUT_SHAPES: readonly StickerThruCutShape[] = ['rounded_rect', 'ellipse', 'contour_offset'];

export const DEFAULT_STICKER_OUTPUT_SETTINGS: Readonly<StickerOutputSettings> = Object.freeze({
    cutMode: 'original',
    offsetMm: 0,
    cornerStyle: 'preserve',
    fillHoles: true,
    bleedMm: 0,
    bleedColorType: 'image',
    solidBleedCmyk: Object.freeze([0, 0, 0, 0]) as StickerSolidBleedCmyk,
    cropToSticker: DEFAULT_CROP_TO_STICKER,
    thrucutEnabled: false,
    thrucutShape: 'rounded_rect',
    thrucutMarginMm: 3,
    thrucutMarginLinked: true,
    thrucutMarginTopMm: 3,
    thrucutMarginBottomMm: 3,
    thrucutMarginLeftMm: 3,
    thrucutMarginRightMm: 3,
    thrucutRadiusMm: 3,
    thrucutSpotName: 'ThruCut',
    thrucutColorHex: '#00FFFF',
    thrucutColorCmyk: Object.freeze([100, 0, 0, 0]) as StickerSolidBleedCmyk,
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

function sanitizeHex(value: unknown, fallback: string): string {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
        ? value.trim().toUpperCase()
        : fallback;
}

function sanitizeSpotName(value: unknown): string {
    if (typeof value !== 'string') return DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutSpotName;
    const trimmed = value.trim().slice(0, 64);
    return trimmed || DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutSpotName;
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
        thrucutEnabled: sanitizeBoolean(
            source.thrucutEnabled,
            DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutEnabled,
        ),
        thrucutShape: sanitizeEnum(
            source.thrucutShape,
            THRUCUT_SHAPES,
            DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutShape,
        ),
        thrucutMarginMm: sanitizeNumber(
            source.thrucutMarginMm,
            DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutMarginMm,
            0.5,
            30,
        ),
        thrucutMarginLinked: sanitizeBoolean(
            source.thrucutMarginLinked,
            DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutMarginLinked,
        ),
        thrucutMarginTopMm: sanitizeNumber(source.thrucutMarginTopMm, DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutMarginTopMm, 0, 50),
        thrucutMarginBottomMm: sanitizeNumber(source.thrucutMarginBottomMm, DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutMarginBottomMm, 0, 50),
        thrucutMarginLeftMm: sanitizeNumber(source.thrucutMarginLeftMm, DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutMarginLeftMm, 0, 50),
        thrucutMarginRightMm: sanitizeNumber(source.thrucutMarginRightMm, DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutMarginRightMm, 0, 50),
        thrucutRadiusMm: sanitizeNumber(
            source.thrucutRadiusMm,
            DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutRadiusMm,
            0,
            20,
        ),
        thrucutSpotName: sanitizeSpotName(source.thrucutSpotName),
        thrucutColorHex: sanitizeHex(
            source.thrucutColorHex,
            DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutColorHex,
        ),
        thrucutColorCmyk: source.thrucutColorCmyk === undefined
            && source.thrucutColorHex === undefined
            ? [...DEFAULT_STICKER_OUTPUT_SETTINGS.thrucutColorCmyk] as StickerSolidBleedCmyk
            : sanitizeSolidBleedCmyk(source.thrucutColorCmyk ?? source.thrucutColorHex),
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
        thrucutEnabled: readLegacyValue(resolvedStorage, 'thrucutEnabled'),
        thrucutShape: readLegacyValue(resolvedStorage, 'thrucutShape'),
        thrucutMarginMm: readLegacyValue(resolvedStorage, 'thrucutMarginMm'),
        thrucutMarginLinked: readLegacyValue(resolvedStorage, 'thrucutMarginLinked'),
        thrucutMarginTopMm: readLegacyValue(resolvedStorage, 'thrucutMarginTopMm'),
        thrucutMarginBottomMm: readLegacyValue(resolvedStorage, 'thrucutMarginBottomMm'),
        thrucutMarginLeftMm: readLegacyValue(resolvedStorage, 'thrucutMarginLeftMm'),
        thrucutMarginRightMm: readLegacyValue(resolvedStorage, 'thrucutMarginRightMm'),
        thrucutRadiusMm: readLegacyValue(resolvedStorage, 'thrucutRadiusMm'),
        thrucutSpotName: readLegacyValue(resolvedStorage, 'thrucutSpotName'),
        thrucutColorHex: readLegacyValue(resolvedStorage, 'thrucutColorHex'),
        thrucutColorCmyk: readLegacyValue(resolvedStorage, 'thrucutColorCmyk'),
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
    writeLegacyValue(resolvedStorage, 'thrucutEnabled', settings.thrucutEnabled);
    writeLegacyValue(resolvedStorage, 'thrucutShape', settings.thrucutShape);
    writeLegacyValue(resolvedStorage, 'thrucutMarginMm', settings.thrucutMarginMm);
    writeLegacyValue(resolvedStorage, 'thrucutMarginLinked', settings.thrucutMarginLinked);
    writeLegacyValue(resolvedStorage, 'thrucutMarginTopMm', settings.thrucutMarginTopMm);
    writeLegacyValue(resolvedStorage, 'thrucutMarginBottomMm', settings.thrucutMarginBottomMm);
    writeLegacyValue(resolvedStorage, 'thrucutMarginLeftMm', settings.thrucutMarginLeftMm);
    writeLegacyValue(resolvedStorage, 'thrucutMarginRightMm', settings.thrucutMarginRightMm);
    writeLegacyValue(resolvedStorage, 'thrucutRadiusMm', settings.thrucutRadiusMm);
    writeLegacyValue(resolvedStorage, 'thrucutSpotName', settings.thrucutSpotName);
    writeLegacyValue(resolvedStorage, 'thrucutColorHex', settings.thrucutColorHex);
    writeLegacyValue(resolvedStorage, 'thrucutColorCmyk', settings.thrucutColorCmyk);

    return settings;
}
