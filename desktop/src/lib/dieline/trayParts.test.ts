import { describe, expect, it } from 'vitest';
import { generateMatchboxTray } from './MatchboxTray';
import { DEFAULT_PARAMS } from './types';
import { splitTrayDieline } from './trayParts';

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
