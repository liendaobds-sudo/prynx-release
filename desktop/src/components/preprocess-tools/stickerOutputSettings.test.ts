import { describe, expect, it } from 'vitest';

import {
    DEFAULT_STICKER_OUTPUT_SETTINGS,
    loadStickerOutputSettings,
    sanitizeStickerOutputSettings,
    saveStickerOutputSettings,
    loadUnifiedStickerOutputSettings,
    saveUnifiedStickerOutputSettings,
    type StickerOutputStorage,
} from './stickerOutputSettings';

class MemoryStorage implements StickerOutputStorage {
    readonly values = new Map<string, string>();

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }
}

function seedJson(storage: MemoryStorage, key: string, value: unknown): void {
    storage.setItem(`ps_sticker_${key}`, JSON.stringify(value));
}

describe('stickerOutputSettings', () => {
    it('unified di trú thông số một lần và không bị khóa rectangle ghi đè', () => {
        const storage = new MemoryStorage();
        seedJson(storage, 'bleedMm', 3.25);
        const migrated = loadUnifiedStickerOutputSettings(storage);
        expect(migrated.bleedMm).toBe(3.25);
        expect(migrated.cropToSticker).toBe(false);
        saveUnifiedStickerOutputSettings(migrated, storage);
        seedJson(storage, 'bleedMm', 8);
        expect(loadUnifiedStickerOutputSettings(storage).bleedMm).toBe(3.25);
    });
    it('dùng mặc định an toàn tương thích StickerTool cũ', () => {
        expect(loadStickerOutputSettings(null)).toEqual({
            cutMode: 'original',
            offsetMm: 0,
            cornerStyle: 'preserve',
            fillHoles: true,
            bleedMm: 0,
            bleedColorType: 'image',
            solidBleedCmyk: [0, 0, 0, 0],
            cropToSticker: true,
        });
        expect(sanitizeStickerOutputSettings(undefined)).toEqual(DEFAULT_STICKER_OUTPUT_SETTINGS);
    });

    it('đọc đầy đủ thiết lập từ các khóa ps_sticker_* cũ', () => {
        const storage = new MemoryStorage();
        seedJson(storage, 'cutMode', 'alpha');
        seedJson(storage, 'offsetMm', 2.5);
        seedJson(storage, 'cornerStyle', 'round');
        seedJson(storage, 'fillHoles', false);
        seedJson(storage, 'bleedMm', 3);
        seedJson(storage, 'bleedColorType', 'solid');
        seedJson(storage, 'bleedColorHex', '10, 20.5, 30, 40');
        seedJson(storage, 'cropToSticker', false);

        expect(loadStickerOutputSettings(storage)).toEqual({
            cutMode: 'alpha',
            offsetMm: 2.5,
            cornerStyle: 'round',
            fillHoles: false,
            bleedMm: 3,
            bleedColorType: 'solid',
            solidBleedCmyk: [10, 20.5, 30, 40],
            cropToSticker: false,
        });
    });

    it('chuyển màu hex cũ sang tuple CMYK và nhận cả chuỗi chưa JSON hóa', () => {
        const storage = new MemoryStorage();
        seedJson(storage, 'bleedColorHex', '#FF0000');
        expect(loadStickerOutputSettings(storage).solidBleedCmyk).toEqual([0, 100, 100, 0]);

        storage.setItem('ps_sticker_bleedColorHex', '0,25,50,75');
        expect(loadStickerOutputSettings(storage).solidBleedCmyk).toEqual([0, 25, 50, 75]);
    });

    it('loại giá trị sai kiểu, enum lạ và mọi NaN/Infinity', () => {
        const settings = sanitizeStickerOutputSettings({
            cutMode: 'legacy-auto',
            offsetMm: Number.NaN,
            cornerStyle: 'bevel',
            fillHoles: 'true',
            bleedMm: Number.POSITIVE_INFINITY,
            bleedColorType: 'mirror',
            solidBleedCmyk: [10, Number.NaN, 30, 40],
            cropToSticker: 1,
            removeWhiteBg: false,
            trimWhiteEdge: true,
        });

        expect(settings).toEqual(DEFAULT_STICKER_OUTPUT_SETTINGS);
        expect(settings).not.toHaveProperty('removeWhiteBg');
        expect(settings).not.toHaveProperty('trimWhiteEdge');
    });

    it('clamp kích thước và từng kênh CMYK vào miền sản xuất cho phép', () => {
        expect(sanitizeStickerOutputSettings({
            offsetMm: -99,
            bleedMm: 99,
            solidBleedCmyk: [-2, 20.125, 130, 50],
        })).toMatchObject({
            offsetMm: -10,
            bleedMm: 10,
            solidBleedCmyk: [0, 20.13, 100, 50],
        });
    });

    it('ghi ngược các khóa cũ bằng dữ liệu đã chuẩn hóa, không đụng thiết lập xử lý nền', () => {
        const storage = new MemoryStorage();
        seedJson(storage, 'removeWhiteBg', false);
        seedJson(storage, 'trimWhiteEdge', true);

        const saved = saveStickerOutputSettings({
            cutMode: 'bleed',
            offsetMm: 50,
            cornerStyle: 'miter',
            fillHoles: false,
            bleedMm: -2,
            bleedColorType: 'solid',
            solidBleedCmyk: [-1, 25, 101, 50],
            cropToSticker: false,
        }, storage);

        expect(saved).toEqual({
            cutMode: 'bleed',
            offsetMm: 10,
            cornerStyle: 'miter',
            fillHoles: false,
            bleedMm: 0,
            bleedColorType: 'solid',
            solidBleedCmyk: [0, 25, 100, 50],
            cropToSticker: false,
        });
        expect(storage.getItem('ps_sticker_cutMode')).toBe(JSON.stringify('bleed'));
        expect(storage.getItem('ps_sticker_offsetMm')).toBe('10');
        expect(storage.getItem('ps_sticker_bleedColorHex')).toBe(JSON.stringify('0,25,100,50'));
        expect(storage.getItem('ps_sticker_removeWhiteBg')).toBe('false');
        expect(storage.getItem('ps_sticker_trimWhiteEdge')).toBe('true');
    });

    it('không ném lỗi khi localStorage bị chặn ở cả lúc đọc và ghi', () => {
        const blockedStorage: StickerOutputStorage = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };

        expect(() => loadStickerOutputSettings(blockedStorage)).not.toThrow();
        expect(loadStickerOutputSettings(blockedStorage)).toEqual(DEFAULT_STICKER_OUTPUT_SETTINGS);
        expect(() => saveStickerOutputSettings({ cutMode: 'alpha' }, blockedStorage)).not.toThrow();
        expect(saveStickerOutputSettings({ cutMode: 'alpha' }, blockedStorage).cutMode).toBe('alpha');
    });
});
