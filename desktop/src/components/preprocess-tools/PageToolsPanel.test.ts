import { describe, expect, it } from 'vitest';
import { createPageToolsActionEvent } from './PageToolsPanel';

describe('PageTools — định tuyến theo tab', () => {
    it('gắn tab đích vào từng lệnh sửa trang', () => {
        const event = createPageToolsActionEvent('tab-pdf-2', 'rotate', { degrees: 90 });

        expect(event.type).toBe('prynx-pagetools-action');
        expect(event.detail).toEqual({
            tabId: 'tab-pdf-2',
            action: 'rotate',
            payload: { degrees: 90 },
        });
    });
});