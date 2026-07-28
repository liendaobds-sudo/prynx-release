import { describe, expect, it } from 'vitest';
import { generateMatchboxTray } from './MatchboxTray';
import { DEFAULT_PARAMS } from './types';
import { splitTrayDieline } from './trayParts';
import { generateDoubleTray, splitDoubleTrayDieline } from './DoubleTray';

describe('splitTrayDieline', () => {
    it('creates isolated tray and sleeve manufacturing models', () => {
        const model = generateMatchboxTray({ ...DEFAULT_PARAMS, boxType: 'tray' });
        const parts = splitTrayDieline(model);
        expect(parts).not.toBeNull();
        expect(parts!.tray.panels.every((panel) => !panel.name.startsWith('sleeve_'))).toBe(true);
        expect(parts!.sleeve.panels.every((panel) => panel.name.startsWith('sleeve_'))).toBe(true);
        expect(parts!.tray.allPaths.length + parts!.sleeve.allPaths.length).toBe(model.allPaths.length);
        expect(parts!.tray.boundingBox.maxX).toBeLessThan(parts!.sleeve.boundingBox.minX);
    });
});

describe('splitDoubleTrayDieline', () => {
    // [DOUBLE-TRAY 2026-07-26] Hộp âm dương dùng chung hạ tầng 2 mảnh —
    // cùng quy ước splitTrayDieline: khe tray = mảnh ĐÁY (base_*),
    // khe sleeve = mảnh NẮP (lid_*), bỏ `nesting`, bbox tính lại theo mảnh.
    it('creates isolated base and lid manufacturing models', () => {
        const model = generateDoubleTray({ ...DEFAULT_PARAMS, boxType: 'double_tray' });
        const parts = splitDoubleTrayDieline(model);
        expect(parts).not.toBeNull();
        expect(parts!.tray.panels.every((panel) => panel.name.startsWith('base_'))).toBe(true);
        expect(parts!.sleeve.panels.every((panel) => panel.name.startsWith('lid_'))).toBe(true);
        expect(parts!.tray.allPaths.length + parts!.sleeve.allPaths.length).toBe(model.allPaths.length);
        expect(parts!.tray.boundingBox.maxX).toBeLessThan(parts!.sleeve.boundingBox.minX);
        expect(parts!.tray.nesting).toBeUndefined();
        expect(parts!.sleeve.nesting).toBeUndefined();
    });

    it('returns null for non double_tray models', () => {
        const model = generateDoubleTray({ ...DEFAULT_PARAMS, boxType: 'double_tray' });
        expect(splitDoubleTrayDieline({ ...model, params: { ...model.params, boxType: 'tray' } })).toBeNull();
    });
});
